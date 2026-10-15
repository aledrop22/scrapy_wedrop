"""Categorias e listagens de produtos do catálogo WeDrop.

A listagem avança uma página por vez, pelo número da página ou pelo botão ">",
e confere que a página mudou de fato antes de continuar. Nunca pula página.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urljoin

from playwright.async_api import Page
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from ..config import BASE_URL, PRODUCTS_PER_PAGE
from ..logs import log_progress
from ..storage.product_status import status_from_availability
from .parsing import parse_first_int, product_id_from_url

CATEGORY_SELECTOR = 'a[draggable="false"][data-group=""]'
MAX_LISTING_PAGES = 500
_PAGE_SETTLE_ATTEMPTS = 40
_PAGINATION_TEXT = re.compile(r"página\s+(\d+)\s+de\s+(\d+)", re.IGNORECASE)
_NEXT_BUTTON_FALLBACKS = (
    'a[rel="next"]',
    'button[aria-label*="next" i]',
    'a[aria-label*="next" i]',
    'button[aria-label*="próxima" i]',
    'a[aria-label*="próxima" i]',
    'button:has-text("Próxima")',
    'button:has-text("Próximo")',
    'a:has-text("Próxima")',
    'a:has-text("Próximo")',
)


@dataclass(frozen=True)
class Category:
    name: str
    url: str
    count: int | None


class ListingError(RuntimeError):
    """A listagem não pôde ser lida com segurança."""


@dataclass(frozen=True)
class ListedProduct:
    """Produto da listagem: endereço e o selo do card ("Ativo", "Inativo" ou "" sem selo)."""

    url: str
    status: str = ""


def listing_status(card_text: str) -> str:
    """Selo do card: uma linha inteira "DISPONÍVEL" ou "INDISPONÍVEL" no topo (antes pode haver a etiqueta VÍDEO)."""
    top_lines = [line.strip() for line in card_text.splitlines() if line.strip()][:3]
    for line in top_lines:
        status = status_from_availability(line)
        if status:
            return status
    return ""


def _merge_listed(target: dict[str, ListedProduct], incoming: dict[str, ListedProduct]) -> None:
    """Junta capturas da listagem. Uma captura sem selo não apaga o selo já lido."""
    for product_id, item in incoming.items():
        if product_id not in target or item.status:
            target[product_id] = item


def filter_categories(categories: list[Category], needle: str | None) -> list[Category]:
    """Nome exato tem prioridade; senão, categorias que contenham o texto."""
    if not needle:
        return categories
    wanted = needle.casefold().strip()
    exact = [category for category in categories if category.name.casefold() == wanted]
    if exact:
        return exact
    matches = [category for category in categories if wanted in category.name.casefold()]
    if not matches:
        available = ", ".join(category.name for category in categories)
        raise RuntimeError(f"Nenhuma categoria corresponde a '{needle}'. Categorias disponíveis: {available}")
    return matches


async def list_categories(page: Page) -> list[Category]:
    links = page.locator(CATEGORY_SELECTOR)
    try:
        await links.first.wait_for(state="visible", timeout=15_000)
    except PlaywrightTimeoutError as exc:
        raise RuntimeError(
            "O catálogo abriu, mas as categorias não apareceram após 15 segundos "
            f"(URL: {page.url}). Confirme se a sessão está autenticada."
        ) from exc

    categories: list[Category] = []
    seen_hrefs: set[str] = set()
    for link in await links.all():
        href = await link.get_attribute("href")
        name = await _category_name(link)
        if not href or not name or href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        categories.append(
            Category(name=name, url=urljoin(BASE_URL, href), count=await _category_count(link))
        )

    if not categories:
        raise RuntimeError(
            "Nenhuma categoria foi encontrada no catálogo autenticado. "
            "A coleta foi interrompida para não registrar um mapeamento vazio."
        )
    return categories


async def _category_name(link) -> str:
    name_node = link.locator("p").first
    if await name_node.count():
        name = (await name_node.inner_text()).strip()
        if name:
            return name
    return (await link.inner_text()).strip()


async def _category_count(link) -> int | None:
    count_node = link.locator('p[class*="1lser6l"]').first
    if await count_node.count():
        count_text = (await count_node.inner_text()).strip()
    else:
        title = await link.get_attribute("title") or ""
        count_text = title.split("—", 1)[1] if "—" in title else ""
    return parse_first_int(count_text)


async def read_category_links(page: Page, category: Category) -> dict[str, str]:
    """Todos os produtos da categoria, como {product_id: url}."""
    listing = await read_category_listing(page, category)
    return {product_id: item.url for product_id, item in listing.items()}


async def read_category_listing(page: Page, category: Category) -> dict[str, ListedProduct]:
    """Todos os produtos da categoria, como {product_id: ListedProduct} (com o selo de cada card)."""
    await page.goto(category.url, wait_until="domcontentloaded")
    await page.wait_for_timeout(800)
    await _set_products_per_page(page, category.count)

    links: dict[str, ListedProduct] = {}
    for _ in range(MAX_LISTING_PAGES):
        _merge_listed(links, await _collect_visible_links(page))
        state = await pagination_state(page)
        if state is None:
            break
        current, total = state
        log_progress(f"Listagem: página {current} de {total}; {len(links)} produtos acumulados.")
        if current >= total:
            break
        if category.count is not None and len(links) >= category.count:
            break
        await _go_to_page(page, category, current + 1)
    else:
        raise ListingError(f"A categoria {category.name} ultrapassou o limite de {MAX_LISTING_PAGES} páginas.")
    return links


def parse_pagination(text: str) -> tuple[int, int] | None:
    """(página atual, total de páginas) a partir do texto 'Página X de Y'."""
    match = _PAGINATION_TEXT.search(text)
    if not match:
        return None
    current, total = (int(value) for value in match.groups())
    if total < 1 or not 1 <= current <= total:
        return None
    return current, total


async def pagination_state(page: Page) -> tuple[int, int] | None:
    return parse_pagination(await page.locator("body").inner_text())


async def _links_on_page(page: Page) -> dict[str, ListedProduct]:
    cards = await page.locator('a[href*="/catalog/"]').evaluate_all(
        "(anchors) => anchors.map((anchor) => ({ href: anchor.href, text: anchor.innerText }))"
    )
    listed: dict[str, ListedProduct] = {}
    for card in cards:
        product_id = product_id_from_url(card["href"])
        if product_id:
            _merge_listed(listed, {product_id: ListedProduct(card["href"], listing_status(card["text"] or ""))})
    return listed


async def _collect_visible_links(page: Page) -> dict[str, ListedProduct]:
    """Rola a listagem até parar de aparecer produto novo (a lista carrega sob demanda)."""
    links: dict[str, ListedProduct] = {}
    previous_count = -1
    unchanged_rounds = 0
    for _ in range(30):
        current = await _links_on_page(page)
        _merge_listed(links, current)
        if len(current) == previous_count:
            unchanged_rounds += 1
            if unchanged_rounds >= 2:
                break
        else:
            unchanged_rounds = 0
            previous_count = len(current)
        await page.mouse.wheel(0, 1200)
        await page.wait_for_timeout(200)
    return links


async def _set_products_per_page(page: Page, expected_products: int | None) -> None:
    select = page.locator("select.chakra-select").first
    await select.wait_for(state="visible", timeout=10_000)
    if not await select.locator(f'option[value="{PRODUCTS_PER_PAGE}"]').count():
        return
    if await select.input_value() != str(PRODUCTS_PER_PAGE):
        await select.select_option(str(PRODUCTS_PER_PAGE))
        await page.wait_for_function(
            "(size) => new URL(location.href).searchParams.get('limit') === String(size)",
            arg=PRODUCTS_PER_PAGE,
        )
    expected_pages = (
        -(-expected_products // PRODUCTS_PER_PAGE) if expected_products is not None else None
    )
    for _ in range(40):
        state = await pagination_state(page)
        if state is not None and (expected_pages is None or state == (1, expected_pages)):
            return
        await page.wait_for_timeout(250)
    raise ListingError(
        "O seletor foi configurado para 100 produtos por página, mas o indicador "
        "de paginação não corresponde à quantidade esperada."
    )


async def _next_button(page: Page):
    """Botão ">" da paginação; se não existir, um dos seletores alternativos."""
    candidates = [page.get_by_role("button", name=">", exact=True).last]
    candidates += [page.locator(selector).last for selector in _NEXT_BUTTON_FALLBACKS]
    for candidate in candidates:
        if await candidate.count() and await candidate.is_visible() and await candidate.is_enabled():
            return candidate
    return None


async def _go_to_page(page: Page, category: Category, target: int) -> None:
    """Vai para a página `target` e só retorna quando ela estiver carregada de fato."""
    numbered = page.get_by_role("button", name=str(target), exact=True).first
    if await numbered.count() and await numbered.is_enabled():
        button = numbered
    else:
        button = await _next_button(page)
        if button is None:
            raise ListingError(
                f"A categoria {category.name} tem mais páginas, mas o botão para "
                f"avançar até a página {target} está indisponível."
            )

    before = set(await _links_on_page(page))
    await button.click()
    for _ in range(_PAGE_SETTLE_ATTEMPTS):
        await page.wait_for_timeout(250)
        state = await pagination_state(page)
        if state is None:
            continue
        if state[0] > target:
            raise ListingError(
                f"A paginação da categoria {category.name} pulou da página "
                f"{target - 1} para {state[0]}."
            )
        if state[0] == target and set(await _links_on_page(page)) != before:
            return
    raise ListingError(f"Não foi possível confirmar a página {target} da categoria {category.name}.")
