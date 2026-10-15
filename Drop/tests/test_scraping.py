"""Leitura do site: funções puras de texto, listagem e montagem do registro do produto."""

import unittest

from wedrop.scraping.catalog import (
    Category,
    ListedProduct,
    _merge_listed,
    filter_categories,
    listing_status,
    parse_pagination,
)
from wedrop.scraping.parsing import (
    calculate_current_balance,
    parse_first_int,
    parse_sales_count,
    product_id_from_url,
    value_for_label,
)
from wedrop.scraping.product_record import PageSnapshot, build_product_record


class ParsingTests(unittest.TestCase):
    def test_pagination_reads_current_and_last_page(self):
        self.assertEqual(parse_pagination("Página 1 de 2"), (1, 2))
        self.assertEqual(parse_pagination("Página 5 de 5"), (5, 5))
        self.assertIsNone(parse_pagination("Página 3 de 2"))
        self.assertIsNone(parse_pagination("Sem paginação"))

    def test_product_id_comes_from_numeric_or_uuid_catalog_links(self):
        self.assertEqual(product_id_from_url("https://dash.wedrop.com.br/catalog/12345"), "12345")
        self.assertEqual(product_id_from_url("https://dash.wedrop.com.br/catalog/categoria-casa"), "")
        self.assertEqual(
            product_id_from_url("https://dash.wedrop.com.br/catalog/3f2a1b4c-1111-2222-3333-444455556666"),
            "3f2a1b4c-1111-2222-3333-444455556666",
        )

    def test_label_values_span_multiple_lines(self):
        self.assertEqual(value_for_label("Saldo real:\n42 un.", ("Saldo real",)), "42 un.")

    def test_sales_count_accepts_only_numbers(self):
        self.assertEqual(parse_sales_count("12"), "12")
        self.assertEqual(parse_sales_count(" 1.200 "), "1200")
        self.assertEqual(parse_sales_count("POR"), "")
        self.assertEqual(parse_sales_count("Vendido por 12"), "")

    def test_first_int_ignores_text_around_the_number(self):
        self.assertEqual(parse_first_int("1.276 produtos"), 1276)
        self.assertIsNone(parse_first_int("sem número"))

    def test_balance_uses_initial_plus_entries_minus_exits(self):
        history = [
            {"type": "Saldo inicial", "quantity": "10"},
            {"type": "ENTRADA", "quantity": "+ 5"},
            {"type": "SAÍDA", "quantity": "- 3"},
        ]
        self.assertEqual(calculate_current_balance(history), 12)

    def test_balance_ignores_signed_numbers_as_initial_balance(self):
        history = [{"type": "Ajuste", "quantity": "- 4"}, {"type": "ENTRADA", "quantity": "+ 2"}]
        self.assertEqual(calculate_current_balance(history), 2)


class ListingStatusTests(unittest.TestCase):
    def test_card_status_is_the_first_line_badge(self):
        self.assertEqual(listing_status("DISPONÍVEL\n\nRosa Artificial\n\nR$ 1,99"), "Ativo")
        self.assertEqual(listing_status("INDISPONÍVEL\n\nRosa Artificial"), "Inativo")
        self.assertEqual(listing_status("  \nIndisponível\nNome"), "Inativo")
        # Card com etiqueta VÍDEO antes do selo
        self.assertEqual(listing_status("VÍDEO\nDISPONÍVEL\n\nÁrvore de Natal\n\nR$ 309,99"), "Ativo")

    def test_card_without_badge_has_no_status(self):
        self.assertEqual(listing_status(""), "")
        self.assertEqual(listing_status("Rosa indisponível em estoque\nR$ 1,99"), "")
        self.assertEqual(listing_status("VÍDEO\n\nNome\n\nDISPONÍVEL depois"), "")

    def test_merge_keeps_a_badge_read_earlier_when_a_later_capture_is_empty(self):
        target = {"1": ListedProduct("https://x/catalog/1", "Inativo")}
        _merge_listed(target, {"1": ListedProduct("https://x/catalog/1", "")})
        self.assertEqual(target["1"].status, "Inativo")
        _merge_listed(target, {"2": ListedProduct("https://x/catalog/2", "")})
        self.assertEqual(target["2"].status, "")


class CategoryFilterTests(unittest.TestCase):
    def setUp(self):
        self.categories = [
            Category("Cozinha", "https://x/cozinha", 1276),
            Category("Cozinha Gourmet", "https://x/gourmet", 40),
            Category("Beleza", "https://x/beleza", 10),
        ]

    def test_exact_name_wins_over_substring_match(self):
        self.assertEqual([c.name for c in filter_categories(self.categories, "cozinha")], ["Cozinha"])

    def test_substring_matches_when_no_exact_name(self):
        self.assertEqual([c.name for c in filter_categories(self.categories, "gourm")], ["Cozinha Gourmet"])

    def test_missing_category_lists_the_available_ones(self):
        with self.assertRaisesRegex(RuntimeError, "Categorias disponíveis: Cozinha"):
            filter_categories(self.categories, "inexistente")


class ProductRecordTests(unittest.TestCase):
    def test_price_with_non_breaking_space_is_kept_as_listed_on_site(self):
        # Mesmo formato do site: <p class="chakra-text css-1enygfq">R$&nbsp;131,99</p>
        snapshot = PageSnapshot(
            title="Panela de Pressão - WeDrop",
            body_text="",
            name_candidates=("Panela de Pressão",),
            price_candidates=("R$\xa0131,99", ""),
            availability_candidates=("Ativo",),
        )
        record = build_product_record("33049", "https://dash.wedrop.com.br/catalog/33049", "Cozinha", snapshot)
        self.assertEqual(record["price"], "R$\xa0131,99")
        self.assertEqual(record["name"], "Panela de Pressão")

    def test_price_falls_back_to_money_in_text_when_selectors_fail(self):
        snapshot = PageSnapshot(
            name_candidates=("Caixa Organizadora",),
            body_text="Caixa Organizadora\nPreço de venda R$ 29,99\nFornecedor: Loja X",
        )
        record = build_product_record("30543", "https://x/30543", "Cozinha", snapshot)
        self.assertEqual(record["price"], "R$ 29,99")
        self.assertEqual(record["supplier"], "Loja X")

    def test_empty_history_gets_informative_placeholder(self):
        snapshot = PageSnapshot(name_candidates=("Produto qualquer",))
        record = build_product_record("1", "https://x/1", "Cozinha", snapshot)
        self.assertEqual(record["stock_history"][0]["type"], "NÃO HOUVE MOVIMENTAÇÃO DE SALDO")

    def test_rows_without_type_or_quantity_do_not_count_toward_balance(self):
        snapshot = PageSnapshot(
            name_candidates=("Produto qualquer",),
            history_rows=(
                {"type": "", "quantity": "7", "date": "", "row_text": ""},
                {"type": "ENTRADA", "quantity": "+ 2", "date": "", "row_text": "Chave da NF: 123"},
            ),
        )
        record = build_product_record("1", "https://x/1", "Cozinha", snapshot)
        self.assertEqual(record["stock"], "2")
        self.assertEqual(record["stock_history"][0]["nf_key"], "123")

    def test_generic_name_is_replaced_by_sku_then_product_id(self):
        with_sku = PageSnapshot(name_candidates=("Produto",), sku_ean_text="SKU: ABC-1 | EAN: 789")
        record = build_product_record("55", "https://x/55", "Cozinha", with_sku)
        self.assertEqual(record["name"], "Produto ABC-1")
        self.assertEqual(record["ean"], "789")

        without_sku = PageSnapshot(name_candidates=("Produto",))
        record = build_product_record("55", "https://x/55", "Cozinha", without_sku)
        self.assertEqual(record["name"], "Produto 55 (Cozinha)")


if __name__ == "__main__":
    unittest.main()
