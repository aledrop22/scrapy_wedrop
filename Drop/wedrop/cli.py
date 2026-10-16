"""Linha de comando: `python -m wedrop coletar` e `python -m wedrop diaria`."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .logs import configure_progress_logging, log_progress
from .lock import CollectionLockedError, collection_lock
from .mapping import DataPaths, MappingOptions, run_mapping
from .protection import DEFAULT_ATTEMPTS, DEFAULT_PAUSE_SECONDS, run_daily
from .config import DEFAULT_WORKERS


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("deve ser maior que zero")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wedrop", description="Mapeia o catálogo WeDrop.")
    commands = parser.add_subparsers(dest="command", required=True)

    manual = commands.add_parser("coletar", help="Coleta única (manual).")
    manual.add_argument("--categoria", help="Coleta só categorias cujo nome contenha este texto.")
    manual.add_argument("--limite", type=_positive_int, help="Limita o total de produtos lidos.")
    manual.add_argument("--local", action="store_true", help="Não envia ao Supabase.")
    manual.add_argument("--workers", type=_positive_int, default=DEFAULT_WORKERS, help="Páginas em paralelo.")
    manual.add_argument("--pasta-dados", type=Path, help="Grava em outra pasta (testes).")

    daily = commands.add_parser("diaria", help="Coleta diária incremental com novas tentativas (agendador).")
    daily.add_argument("--tentativas", type=_positive_int, default=DEFAULT_ATTEMPTS)
    daily.add_argument("--pausa", type=_positive_int, default=DEFAULT_PAUSE_SECONDS, help="Segundos entre tentativas.")
    daily.add_argument("--pasta-dados", type=Path, help="Grava em outra pasta (testes).")
    return parser


def _paths(folder: Path | None) -> DataPaths:
    return DataPaths.in_folder(folder) if folder else DataPaths()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    paths = _paths(args.pasta_dados)
    try:
        with collection_lock():
            if args.command == "coletar":
                options = MappingOptions(
                    category_filter=args.categoria,
                    product_limit=args.limite,
                    local_only=args.local,
                    workers=args.workers,
                )
                summary = asyncio.run(run_mapping(options, paths))
                return 0 if summary.is_complete or summary.partial else 1
            completed = asyncio.run(run_daily(args.tentativas, args.pausa, paths))
            return 0 if completed else 1
    except CollectionLockedError as exc:
        # Ex.: a rotina das 00:00 ainda rodando quando a das 10:00 começa. Não grava nada.
        configure_progress_logging()
        log_progress(f"{exc} Esta execução não começou.")
        return 2
    except KeyboardInterrupt:
        log_progress("Interrompido pelo usuário. O progresso já gravado foi preservado.")
        return 130
    except Exception as exc:
        log_progress(f"Coleta encerrada com erro: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
