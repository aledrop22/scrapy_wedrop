"""Coleta diária incremental: decisão por categoria, troca de registros e leitura de preço e saldo."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wedrop.mapping import MappingSummary, _full_read_reason, _ProductCrawler, _ProductsJsonFile, _refresh_category
from wedrop.scraping.catalog import Category, ListedProduct
from wedrop.scraping.product_page import ProductJob
from wedrop.scraping.product_record import (
    PRICE_CHANGED,
    STOCK_CHANGED,
    UNCHANGED,
    PageSnapshot,
    build_balance_update,
    compare_balance,
    fill_from_known,
)
from wedrop.storage import products_file
from wedrop.storage.sqlite_repository import SalesRepository

COZINHA = Category("Cozinha", "https://x/cozinha", 1276)


def _listed(product_id: str, status: str = "Ativo") -> ListedProduct:
    return ListedProduct(f"https://x/catalog/{product_id}", status)


class ReadDecisionTests(unittest.TestCase):
    def test_category_never_collected_is_read_in_full(self):
        self.assertEqual(_full_read_reason(COZINHA, {}, 0), "categoria ainda não coletada")

    def test_changed_count_is_read_in_full(self):
        reason = _full_read_reason(COZINHA, {"Cozinha": 1270}, 1270)
        self.assertEqual(reason, "quantidade mudou de 1270 para 1276")

    def test_missing_products_in_products_file_are_read_in_full(self):
        reason = _full_read_reason(COZINHA, {"Cozinha": 1276}, 1200)
        self.assertEqual(reason, "o data.json tem 1200 de 1276 produtos disponíveis")

    def test_unchanged_category_needs_only_price_and_balance(self):
        self.assertIsNone(_full_read_reason(COZINHA, {"Cozinha": 1276}, 1276))

    def test_site_without_count_is_read_in_full(self):
        category = Category("Cozinha", "https://x/cozinha", None)
        self.assertIsNotNone(_full_read_reason(category, {"Cozinha": None}, 10))


class BalanceUpdateTests(unittest.TestCase):
    def setUp(self):
        self.known = {
            "price": "R$ 10,00",
            "stock": "3 un.",
            "stock_history": [
                {"type": "Saldo inicial", "quantity": "10"},
                {"type": "ENTRADA", "quantity": "+ 5"},
                {"type": "SAÍDA", "quantity": "- 3"},
            ],
        }

    def test_price_and_stock_come_from_the_page_and_balance_uses_stored_history(self):
        snapshot = PageSnapshot(
            body_text="Cozinha",
            price_candidates=("R$ 49,90",),
            stock_candidates=("11 un.",),
        )
        update = build_balance_update(self.known, snapshot)
        self.assertEqual(update["price"], "R$ 49,90")
        self.assertEqual(update["stock"], "11 un.")
        self.assertEqual(update["real_balance"], "12")
        self.assertEqual(update["total_stock_count"], "12")

    def test_missing_price_keeps_the_stored_price(self):
        update = build_balance_update(self.known, PageSnapshot(body_text=""))
        self.assertEqual(update["price"], "R$ 10,00")


class CompareWithPreviousDayTests(unittest.TestCase):
    known = {"price": "R$ 10,00", "stock": "3 un."}

    def test_same_price_and_stock_is_unchanged(self):
        self.assertEqual(compare_balance(self.known, {"price": "R$ 10,00", "stock": "3 un."}), UNCHANGED)

    def test_only_price_changed(self):
        self.assertEqual(compare_balance(self.known, {"price": "R$ 12,00", "stock": "3 un."}), PRICE_CHANGED)

    def test_stock_change_wins_over_price_change(self):
        self.assertEqual(compare_balance(self.known, {"price": "R$ 12,00", "stock": "2 un."}), STOCK_CHANGED)

    def test_reread_keeps_previous_value_of_fields_left_empty(self):
        record = {"price": "R$ 12,00", "cnpj": "", "stock": "2 un."}
        merged = fill_from_known(record, {"price": "R$ 10,00", "cnpj": "12.345.678/0001-90", "stock": "3 un."})
        self.assertEqual(merged, {"price": "R$ 12,00", "cnpj": "12.345.678/0001-90", "stock": "2 un."})


class ProductsJsonFileTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.path = Path(self._temp.name) / "data.json"
        lines = [
            {"product_id": "1", "category": "Cozinha", "price": "10", "url": "u1"},
            {"product_id": "2", "category": "Casa", "price": "20", "url": "u2"},
        ]
        self.path.write_text(
            "\n".join([json.dumps(lines[0]), "linha quebrada", json.dumps(lines[1])]) + "\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self._temp.cleanup()

    def test_groups_stored_products_by_category(self):
        grouped = _ProductsJsonFile(self.path).by_category()
        self.assertEqual([record["product_id"] for record in grouped["Cozinha"]], ["1"])
        self.assertEqual([record["product_id"] for record in grouped["Casa"]], ["2"])

    def test_upsert_replaces_in_place_and_appends_new_products(self):
        products_json = _ProductsJsonFile(self.path)
        products_json.upsert([
            {"product_id": "1", "category": "Cozinha", "price": "12"},
            {"product_id": "3", "category": "Cozinha", "price": "5"},
        ])
        products_json.save()

        records = products_file.read_records(self.path)
        self.assertEqual(records[0], {"product_id": "1", "category": "Cozinha", "price": "12"})
        self.assertEqual(records[1], "linha quebrada")
        self.assertEqual(records[2]["product_id"], "2")
        self.assertEqual(records[3]["product_id"], "3")


class FakeCrawler:
    """Registra as leituras pedidas; cada chamada falha nos IDs indicados em `failures_per_call`."""

    def __init__(self, failures_per_call=()):
        self.calls: list[list[ProductJob]] = []
        self._failures = list(failures_per_call)

    async def crawl(self, jobs):
        self.calls.append(jobs)
        failing = self._failures.pop(0) if self._failures else set()
        return [(job, RuntimeError("falha simulada")) for job in jobs if job.product_id in failing]


class RefreshCategoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        folder = Path(self._temp.name)
        self.repository = SalesRepository(folder / "banco.db")
        # Última coleta: 1 produto; o site agora informa 2.
        self.repository.save_category({"url": COZINHA.url, "name": "Cozinha", "count": 1}, 1, "2026-10-12T10:00:00-03:00")
        self.path = folder / "data.json"
        self.path.write_text(
            "\n".join(
                json.dumps(record)
                for record in (
                    {"product_id": "1", "category": "Cozinha", "price": "10", "url": "https://x/catalog/1",
                     "availability": "Disponível", "is_active": "Ativo", "stock_history": []},
                    {"product_id": "2", "category": "Cozinha", "price": "20", "url": "https://x/catalog/2",
                     "availability": "Disponível", "is_active": "Ativo", "stock_history": []},
                    {"product_id": "3", "category": "Casa", "price": "30", "url": "https://x/catalog/3",
                     "availability": "Disponível", "is_active": "Ativo", "stock_history": []},
                    # Já esgotado em coleta anterior: não deve ser relido enquanto estiver fora da listagem.
                    {"product_id": "4", "category": "Cozinha", "price": "40", "url": "https://x/catalog/4",
                     "availability": "Indisponível", "is_active": "Inativo", "stock_history": []},
                )
            )
            + "\n",
            encoding="utf-8",
        )
        self.products_json = _ProductsJsonFile(self.path)

    def tearDown(self):
        self.repository.close()
        self._temp.cleanup()

    async def _refresh(self, count, baseline, listing=None, failures_per_call=(), shortfall=False):
        category = Category("Cozinha", COZINHA.url, count)
        known = self.products_json.by_category().get("Cozinha", [])
        summary = MappingSummary()
        crawler = FakeCrawler(failures_per_call)

        async def fake_listing(_page, _category, current_summary):
            if shortfall:
                current_summary.shortfall_categories.append("Cozinha")
            return listing or {}

        with patch("wedrop.mapping._read_listing", new=fake_listing):
            await _refresh_category(
                "[1/1] Cozinha",
                category,
                {"Cozinha": baseline},
                known,
                None,
                crawler,
                self.products_json,
                self.repository,
                None,
                "2026-10-13T10:00:00-03:00",
                summary,
            )
        return summary, crawler

    async def test_unchanged_category_reads_only_stored_products_without_listing(self):
        summary, crawler = await self._refresh(count=2, baseline=2)

        self.assertEqual(summary.balance_only_categories, ["Cozinha"])
        self.assertEqual(summary.full_categories, [])
        self.assertEqual([job.product_id for job in crawler.calls[0]], ["1", "2"])
        self.assertTrue(all(job.known_record is not None for job in crawler.calls[0]))
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 2})

    async def test_product_saved_without_status_is_read_in_full(self):
        # Página lida antes do selo Disponível/Indisponível: registro sem status.
        records = [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines()]
        records[1].update(availability="", is_active="")
        self.path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        self.products_json = _ProductsJsonFile(self.path)

        _summary, crawler = await self._refresh(count=2, baseline=2)

        jobs = {job.product_id: job.known_record for job in crawler.calls[0]}
        self.assertIsNotNone(jobs["1"])
        self.assertIsNone(jobs["2"])

    async def test_changed_category_reads_new_and_sold_out_products_in_full_and_keeps_them(self):
        # Produto 2 saiu da listagem (acabou o estoque); produto 9 entrou.
        listing = {"1": _listed("1"), "9": _listed("9")}
        summary, crawler = await self._refresh(count=2, baseline=1, listing=listing)

        self.assertEqual(summary.full_categories, ["Cozinha"])
        self.assertEqual(summary.balance_only_categories, [])
        listed, gone = crawler.calls
        self.assertEqual([job.product_id for job in listed], ["1", "9"])
        self.assertIsNotNone(listed[0].known_record)  # já salvo: compara preço e saldo
        self.assertIsNone(listed[1].known_record)  # novo: leitura completa
        self.assertEqual([(job.product_id, job.known_record) for job in gone], [("2", None)])
        stored_ids = sorted(record["product_id"] for record in self.products_json.by_category()["Cozinha"])
        self.assertEqual(stored_ids, ["1", "2", "4"])
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 2})

    async def test_sold_out_product_whose_badge_says_available_is_read_again(self):
        # Voltou ao estoque: a listagem mostra Disponível, então é comparado e lido
        listing = {"1": _listed("1"), "2": _listed("2"), "4": _listed("4", "Ativo")}
        _, crawler = await self._refresh(count=3, baseline=2, listing=listing)

        listed, gone = crawler.calls
        self.assertEqual([job.product_id for job in listed], ["1", "2", "4"])
        self.assertIsNotNone(listed[2].known_record)
        self.assertEqual(gone, [])

    async def test_sold_out_product_with_sold_out_badge_is_not_opened_on_count_change(self):
        # Quantidade mudou, mas o produto 4 segue Indisponível na listagem: não é aberto
        listing = {"1": _listed("1"), "2": _listed("2"), "4": _listed("4", "Inativo"), "9": _listed("9")}
        summary, crawler = await self._refresh(count=4, baseline=2, listing=listing)

        self.assertEqual(summary.full_categories, ["Cozinha"])
        listed, gone = crawler.calls
        self.assertEqual([job.product_id for job in listed], ["1", "2", "9"])
        self.assertEqual(gone, [])
        self.assertIn("4", [record["product_id"] for record in self.products_json.by_category()["Cozinha"]])
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 4})

    async def test_sold_out_product_without_badge_is_read_to_be_safe(self):
        listing = {"1": _listed("1"), "2": _listed("2"), "4": _listed("4", "")}
        _, crawler = await self._refresh(count=3, baseline=2, listing=listing)

        self.assertEqual([job.product_id for job in crawler.calls[0]], ["1", "2", "4"])

    async def test_sold_out_product_that_fails_to_open_does_not_block_the_category(self):
        listing = {"1": _listed("1")}
        summary, _ = await self._refresh(count=1, baseline=2, listing=listing, failures_per_call=[set(), {"2"}])

        self.assertEqual(summary.failed_ids, [])
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 1})

    async def test_failed_balance_read_is_retried_only_for_failed_products(self):
        listing = {"1": _listed("1"), "2": _listed("2")}
        summary, crawler = await self._refresh(
            count=2, baseline=2, listing=listing, failures_per_call=[{"2"}, set()]
        )

        # Falha pontual não reabre a categoria inteira: relê só o produto 2 e fecha a categoria
        self.assertEqual(summary.balance_only_categories, ["Cozinha"])
        self.assertEqual(summary.full_categories, [])
        self.assertEqual(len(crawler.calls), 2)
        light, retry = crawler.calls
        self.assertEqual([job.product_id for job in retry], ["2"])
        self.assertEqual(summary.failed_ids, [])
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 2})

    async def test_incomplete_listing_keeps_old_baseline_so_next_run_reads_again(self):
        listing = {"1": _listed("1")}
        summary, _ = await self._refresh(count=2, baseline=1, listing=listing, shortfall=True)

        self.assertEqual(summary.full_categories, ["Cozinha"])
        self.assertEqual(self.repository.category_baselines(), {"Cozinha": 1})
        self.assertFalse(summary.is_complete)


class CrawlerRecordTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_saved_product_has_read_time_and_position_in_category(self):
        class Reader:
            async def read(self, job):
                return None if job.product_id == "2" else {"product_id": job.product_id}

        class Sink:
            def __init__(self):
                self.saved = []

            def add(self, product):
                self.saved.append(product)

            def flush(self):
                pass

        sink = Sink()
        jobs = [ProductJob(str(number), f"https://x/catalog/{number}", "Cozinha") for number in (1, 2, 3)]
        await _ProductCrawler([Reader()], sink, relogin=None).crawl(jobs)

        self.assertEqual([product["leitura_categoria"] for product in sink.saved], ["1/3", "3/3"])
        self.assertRegex(sink.saved[0]["lido_em"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


class BaselineTests(unittest.TestCase):
    def test_last_saved_count_per_category_is_the_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            repository = SalesRepository(Path(folder) / "banco.db")
            try:
                self.assertEqual(repository.category_baselines(), {})
                repository.save_category({"url": COZINHA.url, "name": "Cozinha", "count": 1276}, 1276, "2026-10-12T10:00:00-03:00")
                self.assertEqual(repository.category_baselines(), {"Cozinha": 1276})
            finally:
                repository.close()


if __name__ == "__main__":
    unittest.main()
