"""Coleta completa do catálogo: categorias, listagens, produtos e gravação.

Regras de execução:
- Sempre cria um backup do data.json antes de tocar nele.
- Coleta concluída anteriormente: começa do zero (o data.json é reescrito).
- Coleta interrompida (erro ou queda): retoma sem apagar nada, sem repetir o
  que já está salvo, e completa o que faltou em relação ao site.
- Coleta parcial (--categoria ou --limite): só acrescenta dados e não altera o estado.

Coleta diária incremental (run_incremental): compara a quantidade de cada categoria
com a última coleta. Igual: compara preço e saldo de cada produto com o dia anterior
(saldo mudou: lê o histórico de saldo, onde estão as vendas). Diferente (ou sem
registro anterior): lê a categoria inteira.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from playwright.async_api import BrowserContext, Page, async_playwright

from .config import (
    BACKUP_DIR,
    BATCH_SIZE,
    DATABASE_FILE,
    DEFAULT_WORKERS,
    PRODUCTS_FILE,
    RUN_STATE_FILE,
    load_environment,
)
from .logs import configure_progress_logging, log_progress
from .scraping.browser import open_browser
from .scraping.catalog import Category, ListedProduct, ListingError, filter_categories, list_categories, read_category_listing
from .scraping.product_page import ProductJob, ProductReader
from .scraping.session import SessionExpiredError, ensure_authenticated
from .storage import products_file
from .storage.product_status import INACTIVE, effective_status
from .storage.run_state import COMPLETED, IN_PROGRESS, load_run_state, save_run_state
from .storage.sqlite_repository import SalesRepository
from .storage.supabase_repository import SupabaseRepository

MAX_RELOGINS_PER_CRAWL = 3


@dataclass(frozen=True)
class DataPaths:
    """Onde ficam os arquivos da coleta. Pode ser trocado para testes em pasta temporária."""

    products_file: Path = PRODUCTS_FILE
    backup_dir: Path = BACKUP_DIR
    state_file: Path = RUN_STATE_FILE
    database_file: Path = DATABASE_FILE

    @classmethod
    def in_folder(cls, folder: Path) -> DataPaths:
        return cls(
            products_file=folder / "data.json",
            backup_dir=folder / "backups",
            state_file=folder / "estado_coleta.json",
            database_file=folder / "wedrop_monitoramento.db",
        )


@dataclass(frozen=True)
class MappingOptions:
    category_filter: str | None = None
    product_limit: int | None = None
    local_only: bool = False
    workers: int = DEFAULT_WORKERS
    ask_for_credentials: bool = True

    @property
    def is_partial(self) -> bool:
        return self.category_filter is not None or self.product_limit is not None


@dataclass
class MappingSummary:
    categories: int = 0
    site_total: int = 0
    saved_total: int = 0
    resumed: bool = False
    partial: bool = False
    shortfall_categories: list[str] = field(default_factory=list)
    failed_ids: list[str] = field(default_factory=list)
    balance_only_categories: list[str] = field(default_factory=list)
    full_categories: list[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        return not self.partial and not self.shortfall_categories and not self.failed_ids


class _ProductsJsonFile:
    """data.json da coleta diária. Um produto relido substitui o registro antigo.

    A coleta completa só acrescenta linhas. Aqui o arquivo inteiro é reescrito de
    forma atômica ao fim de cada categoria, porque os registros são trocados.
    """

    def __init__(self, path: Path):
        self._path = path
        self._records: list[products_file.Record] = products_file.read_records(path)
        self._position: dict[str, int] = {
            str(record["product_id"]): index
            for index, record in enumerate(self._records)
            if isinstance(record, dict) and record.get("product_id")
        }

    def by_category(self) -> dict[str, list[dict]]:
        grouped: dict[str, list[dict]] = {}
        for index in self._position.values():
            record = self._records[index]
            grouped.setdefault(str(record.get("category", "")), []).append(record)
        return grouped

    def upsert(self, records: list[dict]) -> None:
        for record in records:
            product_id = str(record["product_id"])
            index = self._position.get(product_id)
            if index is None:
                self._position[product_id] = len(self._records)
                self._records.append(record)
            else:
                self._records[index] = record

    def save(self) -> None:
        products_file.write_records_atomic(self._path, self._records)


class _BatchSink:
    """Grava cada lote no SQLite, no data.json e no Supabase, nessa ordem."""

    def __init__(
        self,
        paths: DataPaths,
        repository: SalesRepository,
        supabase: SupabaseRepository | None,
        captured_at: str,
        products_json: _ProductsJsonFile | None = None,
    ):
        self._paths = paths
        self._repository = repository
        self._supabase = supabase
        self._captured_at = captured_at
        self._products_json = products_json
        self._batch: list[dict] = []

    def add(self, product: dict) -> None:
        self._batch.append(product)
        if len(self._batch) >= BATCH_SIZE:
            self.flush()

    def flush(self) -> None:
        if not self._batch:
            return
        batch, self._batch = self._batch, []
        self._repository.save_products(batch, self._captured_at)
        file_records = [products_file.file_record(product, self._captured_at) for product in batch]
        if self._products_json is None:
            products_file.append_records(self._paths.products_file, file_records)
        else:
            self._products_json.upsert(file_records)
        if self._supabase is not None:
            self._supabase.save_products(batch, self._captured_at)
        destinations = "SQLite e data.json" + ("" if self._supabase is None else " e Supabase")
        log_progress(f"Lote de {len(batch)} produtos gravado em {destinations}.")


class _ProductCrawler:
    """Lê os produtos com uma página do navegador por worker e entrega cada um ao sink."""

    def __init__(self, readers: list[ProductReader], sink: _BatchSink, relogin):
        self._readers = readers
        self._sink = sink
        self._relogin = relogin
        self._done = 0
        self._total = 0
        self._unchanged = 0

    async def crawl(self, jobs: list[ProductJob]) -> list[tuple[ProductJob, Exception]]:
        pending: deque[ProductJob] = deque(jobs)
        self._done, self._total, self._unchanged = 0, len(jobs), 0
        failures: list[tuple[ProductJob, Exception]] = []
        relogins = 0
        while pending:
            session_lost = asyncio.Event()
            await asyncio.gather(
                *(self._work(reader, pending, failures, session_lost) for reader in self._readers)
            )
            if session_lost.is_set():
                relogins += 1
                if relogins > MAX_RELOGINS_PER_CRAWL:
                    raise RuntimeError("A sessão WeDrop expirou repetidamente; a coleta foi interrompida.")
                self._sink.flush()
                log_progress("  Sessão WeDrop expirou; reautenticando e retomando de onde parou...")
                await self._relogin()
        self._sink.flush()
        if self._unchanged:
            log_progress(f"  {self._unchanged} de {self._total} produtos sem mudança de preço e saldo; mantidos como estavam.")
        return failures

    async def _work(
        self,
        reader: ProductReader,
        pending: deque[ProductJob],
        failures: list[tuple[ProductJob, Exception]],
        session_lost: asyncio.Event,
    ) -> None:
        while pending and not session_lost.is_set():
            job = pending.popleft()
            try:
                product = await reader.read(job)
            except SessionExpiredError:
                pending.appendleft(job)
                session_lost.set()
                return
            except Exception as exc:  # um produto com erro não derruba a coleta inteira
                failures.append((job, exc))
                log_progress(f"  ERRO ao ler produto {job.product_id}: {exc}")
                continue
            self._done += 1
            if product is None:  # preço e saldo iguais ao dia anterior: nada a gravar
                self._unchanged += 1
                continue
            product = {
                **product,
                # Mesma hora e contagem do terminal ([222/241]), para analisar o data.json.
                "lido_em": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "leitura_categoria": f"{self._done}/{self._total}",
            }
            self._report(product)
            self._sink.add(product)

    def _report(self, product: dict) -> None:
        missing = []
        if not product.get("name") or len(product["name"]) < 3:
            missing.append("nome")
        if not product.get("price"):
            missing.append("preço")
        if not product.get("availability"):
            missing.append("disponibilidade")
        if missing:
            log_progress(f"⚠️ Campos vazios: {', '.join(missing)} (ID {product['product_id']})")
        log_progress(
            f"[{self._done}/{self._total}] {product.get('name') or 'nome indisponível'} "
            f"(ID {product['product_id']}): {len(product.get('stock_history', []))} movimentações."
        )


async def _read_listing(page: Page, category: Category, summary: MappingSummary) -> dict[str, ListedProduct]:
    """Lista da categoria. Se faltar produto em relação ao site, avisa e registra a divergência."""
    listing = await read_category_listing(page, category)
    if category.count is not None and len(listing) < category.count:
        log_progress(
            f"AVISO: o site informa {category.count} produtos em {category.name}, "
            f"mas a listagem trouxe {len(listing)}."
        )
        summary.shortfall_categories.append(category.name)
    return listing


def _prepare_products_file(paths: DataPaths, options: MappingOptions, state) -> bool:
    """Backup e preparação do data.json. Retorna True quando a coleta retoma uma anterior."""
    backup = products_file.backup_products_file(paths.products_file, paths.backup_dir)
    if backup is not None:
        log_progress(f"Backup de segurança criado: {backup.name}")
    products_file.compress_old_backups(paths.backup_dir)

    resuming = options.is_partial or (state is not None and state.is_in_progress)
    if not resuming:
        products_file.write_records_atomic(paths.products_file, [])
        log_progress("Coleta anterior concluída: data.json será reescrito do zero.")
    elif not options.is_partial:
        # Não restaura produtos de backups: um backup antigo traz dados de dias
        # anteriores e faria produtos parecerem coletados hoje sem nova leitura.
        log_progress("Coleta anterior incompleta: retomando sem repetir produtos já salvos.")
    return resuming


async def run_mapping(
    options: MappingOptions = MappingOptions(),
    paths: DataPaths = DataPaths(),
) -> MappingSummary:
    load_environment()
    configure_progress_logging()
    log_progress("Iniciando coleta completa do catálogo WeDrop.")
    log_progress(f"Destino JSON: {paths.products_file}")

    supabase = None
    if not options.local_only:
        supabase = SupabaseRepository.from_environment()
        supabase.validate()
        log_progress("Conexão e tabelas Supabase validadas.")

    state = None if options.is_partial else load_run_state(paths.state_file)
    resuming = _prepare_products_file(paths, options, state)
    summary = MappingSummary(resumed=resuming, partial=options.is_partial)
    if not options.is_partial:
        save_run_state(paths.state_file, IN_PROGRESS, saved_total=len(products_file.read_product_ids(paths.products_file)))

    repository = SalesRepository(paths.database_file)
    captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
    sink = _BatchSink(paths, repository, supabase, captured_at)
    try:
        async with async_playwright() as playwright:
            browser, context = await open_browser(playwright)
            try:
                await _map_catalog(context, options, paths, sink, repository, supabase, captured_at, summary)
            finally:
                await browser.close()
    finally:
        repository.close()
        if supabase is not None:
            supabase.close()

    _finish(paths, summary)
    return summary


async def _map_catalog(
    context: BrowserContext,
    options: MappingOptions,
    paths: DataPaths,
    sink: _BatchSink,
    repository: SalesRepository,
    supabase: SupabaseRepository | None,
    captured_at: str,
    summary: MappingSummary,
) -> None:
    pages = [await context.new_page() for _ in range(max(1, options.workers))]
    listing_page = pages[0]

    async def relogin() -> None:
        await ensure_authenticated(listing_page, context, ask_user=options.ask_for_credentials)

    await relogin()
    categories = filter_categories(await list_categories(listing_page), options.category_filter)
    summary.categories = len(categories)
    summary.site_total = sum(category.count or 0 for category in categories)
    log_progress(f"Categorias selecionadas: {len(categories)}; o site informa {summary.site_total} produtos.")

    saved_ids = products_file.read_product_ids(paths.products_file)
    crawler = _ProductCrawler([ProductReader(page) for page in pages], sink, relogin)
    remaining = options.product_limit
    for index, category in enumerate(categories, 1):
        log_progress(f"[{index}/{len(categories)}] Lendo listagem da categoria {category.name}...")
        links = await _read_listing(listing_page, category, summary)
        pending = [
            ProductJob(product_id, item.url, category.name)
            for product_id, item in links.items()
            if product_id not in saved_ids
        ]
        if remaining is not None:
            pending = pending[:remaining]
            remaining -= len(pending)

        repository.save_category(_as_dict(category), len(links), captured_at)
        if supabase is not None:
            supabase.save_category(_as_dict(category), len(links), captured_at)
        log_progress(f"Categoria {category.name}: {len(links)} listados, {len(pending)} a ler.")
        if pending:
            failures = await crawler.crawl(pending)
            summary.failed_ids.extend(job.product_id for job, _ in failures)
        if remaining == 0:
            break


def _as_dict(category: Category) -> dict:
    return {"name": category.name, "url": category.url, "count": category.count}


def _finish(paths: DataPaths, summary: MappingSummary) -> None:
    summary.saved_total = len(products_file.read_product_ids(paths.products_file))
    if not summary.partial:
        status = COMPLETED if summary.is_complete else IN_PROGRESS
        save_run_state(paths.state_file, status, summary.site_total, summary.saved_total)
    log_progress(
        f"Comparação com o site: {summary.site_total} produtos informados; "
        f"data.json com {summary.saved_total} (diferença {max(summary.site_total - summary.saved_total, 0)})."
    )
    if summary.failed_ids:
        log_progress(f"Produtos com erro, retomados na próxima execução: {summary.failed_ids[:20]}")
    log_progress("Mapeamento concluído." if summary.is_complete else "Mapeamento incompleto; execute novamente para retomar.")


async def run_incremental(
    options: MappingOptions = MappingOptions(),
    paths: DataPaths = DataPaths(),
) -> MappingSummary:
    """Coleta diária: lê só o que pode ter mudado desde a última coleta.

    Quantidade igual à da última coleta e produtos já guardados: compara preço e saldo
    com o dia anterior. Sem mudança, nada é gravado; preço mudou, grava o preço; saldo
    mudou, lê o histórico de saldo para registrar as vendas.
    Quantidade diferente, categoria nova ou produtos faltando no data.json: lê a
    categoria inteira. Falha numa leitura rápida também leva à categoria inteira.
    """
    load_environment()
    configure_progress_logging()
    log_progress("Iniciando coleta diária incremental do catálogo WeDrop.")
    log_progress(f"Destino JSON: {paths.products_file}")

    supabase = None
    if not options.local_only:
        supabase = SupabaseRepository.from_environment()
        supabase.validate()
        log_progress("Conexão e tabelas Supabase validadas.")

    backup = products_file.backup_products_file(paths.products_file, paths.backup_dir)
    if backup is not None:
        log_progress(f"Backup de segurança criado: {backup.name}")
    products_file.compress_old_backups(paths.backup_dir)

    repository = SalesRepository(paths.database_file)
    captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
    products_json = _ProductsJsonFile(paths.products_file)
    sink = _BatchSink(paths, repository, supabase, captured_at, products_json)
    summary = MappingSummary()
    try:
        async with async_playwright() as playwright:
            browser, context = await open_browser(playwright)
            try:
                await _refresh_catalog(context, options, products_json, sink, repository, supabase, captured_at, summary)
            finally:
                await browser.close()
    finally:
        sink.flush()
        products_json.save()
        repository.close()
        if supabase is not None:
            supabase.close()

    log_progress(
        f"Resumo: {len(summary.balance_only_categories)} categoria(s) só com preço e saldo; "
        f"{len(summary.full_categories)} lida(s) por inteiro."
    )
    _finish(paths, summary)
    return summary


async def _refresh_catalog(
    context: BrowserContext,
    options: MappingOptions,
    products_json: _ProductsJsonFile,
    sink: _BatchSink,
    repository: SalesRepository,
    supabase: SupabaseRepository | None,
    captured_at: str,
    summary: MappingSummary,
) -> None:
    pages = [await context.new_page() for _ in range(max(1, options.workers))]
    listing_page = pages[0]

    async def relogin() -> None:
        await ensure_authenticated(listing_page, context, ask_user=options.ask_for_credentials)

    await relogin()
    categories = await list_categories(listing_page)
    summary.categories = len(categories)
    summary.site_total = sum(category.count or 0 for category in categories)
    log_progress(f"Categorias no site: {len(categories)}; o site informa {summary.site_total} produtos.")

    baselines = repository.category_baselines()
    stored = products_json.by_category()
    crawler = _ProductCrawler([ProductReader(page) for page in pages], sink, relogin)
    for index, category in enumerate(categories, 1):
        try:
            await _refresh_category(
                f"[{index}/{len(categories)}] {category.name}",
                category,
                baselines,
                stored.get(category.name, []),
                listing_page,
                crawler,
                products_json,
                repository,
                supabase,
                captured_at,
                summary,
            )
        except ListingError as exc:
            # Uma categoria com paginação quebrada não derruba as outras: fica incompleta e é tentada de novo
            log_progress(f"Categoria {category.name} não pôde ser listada ({exc}); seguindo para a próxima.")
            summary.shortfall_categories.append(category.name)
        sink.flush()
        products_json.save()


async def _refresh_category(
    label: str,
    category: Category,
    baselines: dict[str, int | None],
    known: list[dict],
    listing_page: Page,
    crawler: _ProductCrawler,
    products_json: _ProductsJsonFile,
    repository: SalesRepository,
    supabase: SupabaseRepository | None,
    captured_at: str,
    summary: MappingSummary,
) -> None:
    # Esgotados (Indisponível) não são relidos: quando voltarem a ter saldo, voltam à
    # listagem, a quantidade da categoria sobe e eles são lidos de novo.
    available = [record for record in known if not _is_sold_out(record)]
    # Compara com todos os produtos guardados (esgotados inclusive): a quantidade do site
    # também conta os esgotados. Comparar só os disponíveis forçava leitura completa todo dia.
    reason = _full_read_reason(category, baselines, len(known))
    if reason is None:
        log_progress(
            f"{label}: {category.count} produtos, sem alteração; comparando preço e saldo de "
            f"{len(available)} com o dia anterior ({len(known) - len(available)} esgotados ignorados)."
        )
        failures = await crawler.crawl([_balance_job(record, category) for record in available])
        if failures:
            # Falha pontual (página que não carregou): relê só esses produtos, não a categoria inteira
            log_progress(f"  {len(failures)} produto(s) não lidos; releitura só deles.")
            failures = await crawler.crawl([job for job, _ in failures])
        if not failures:
            summary.balance_only_categories.append(category.name)
            _save_category(repository, supabase, category, len(available), captured_at)
            return
        summary.failed_ids.extend(job.product_id for job, _ in failures)
        log_progress(
            f"Categoria {category.name} não ficou completa; a próxima execução relê só os produtos que faltaram."
        )
        return

    log_progress(f"{label}: categoria inteira ({reason}).")
    summary.full_categories.append(category.name)
    listing = await _read_listing(listing_page, category, summary)
    known_by_id = {str(record["product_id"]): record for record in known}
    # Esgotado com selo Indisponível na listagem não é aberto: a página não traria nada novo.
    # Esgotado com selo Disponível (voltou ao estoque) ou sem selo é lido como os demais.
    skipped = [
        product_id
        for product_id, item in listing.items()
        if product_id in known_by_id and _is_sold_out(known_by_id[product_id]) and item.status == INACTIVE
    ]
    skipped_set = set(skipped)
    listed_jobs = [
        _balance_job(known_by_id[product_id], category)
        if product_id in known_by_id
        else ProductJob(product_id, item.url, category.name)
        for product_id, item in listing.items()
        if product_id not in skipped_set
    ]
    new_count = sum(1 for product_id in listing if product_id not in known_by_id)
    # Produto que acabou de sair da listagem esgotou: a página dele mostra as últimas
    # vendas no histórico e o selo Indisponível. Continua salvo e é lido por inteiro uma
    # vez; quem já estava esgotado não é relido. Esgotado que voltou à listagem é comparado.
    gone = [
        record
        for product_id, record in known_by_id.items()
        if product_id not in listing and not _is_sold_out(record)
    ]
    log_progress(
        f"Categoria {category.name}: {len(listing)} listados ({new_count} novos, "
        f"{len(skipped)} esgotados pulados pelo selo); "
        f"{len(gone)} acabaram de sair da listagem e serão lidos por inteiro."
    )
    failures = await crawler.crawl(listed_jobs)
    summary.failed_ids.extend(job.product_id for job, _ in failures)
    gone_failures = await crawler.crawl(
        [ProductJob(str(record["product_id"]), str(record.get("url", "")), category.name) for record in gone]
    )
    if gone_failures:
        # A página pode ter sido removida do site; o registro anterior fica como estava.
        log_progress(f"  {len(gone_failures)} produto(s) que saíram da listagem não abriram; mantidos como estavam.")
    if failures or category.name in summary.shortfall_categories:
        log_progress(f"Categoria {category.name} não ficou completa; a próxima execução a lê de novo.")
        return
    _save_category(repository, supabase, category, len(listing), captured_at)


def _full_read_reason(category: Category, baselines: dict[str, int | None], stored_count: int) -> str | None:
    """Motivo para ler a categoria inteira; None quando basta ler preço e saldo."""
    if category.count is None:
        return "o site não informou a quantidade de produtos"
    if category.name not in baselines:
        return "categoria ainda não coletada"
    previous = baselines[category.name]
    if previous != category.count:
        return f"quantidade mudou de {previous} para {category.count}"
    if stored_count < category.count:
        return f"o data.json tem {stored_count} de {category.count} produtos disponíveis"
    return None


def _is_sold_out(record: dict) -> bool:
    return effective_status(record.get("is_active"), record.get("availability")) == INACTIVE


def _balance_job(record: dict, category: Category) -> ProductJob:
    # Registro salvo sem status (página lida antes do cabeçalho carregar) é relido por inteiro.
    known = record if effective_status(record.get("is_active"), record.get("availability")) else None
    return ProductJob(str(record["product_id"]), str(record.get("url", "")), category.name, known)


def _save_category(
    repository: SalesRepository,
    supabase: SupabaseRepository | None,
    category: Category,
    mapped_products: int,
    captured_at: str,
) -> None:
    repository.save_category(_as_dict(category), mapped_products, captured_at)
    if supabase is not None:
        supabase.save_category(_as_dict(category), mapped_products, captured_at)
