# WeDrop — coleta de catálogo e painel de vendas

## Como usar

| Para quê | Comando |
|---|---|
| Coleta manual (retoma se a anterior foi interrompida) | `coletar.bat` ou `python -m wedrop coletar` |
| Só algumas categorias | `python -m wedrop coletar --categoria Cozinha` |
| Painel de vendas e estoque | `painel.bat` |
| Coleta diária incremental (agendador do Windows) | `python -m wedrop diaria` |
| Preencher preços que faltam no data.json | `python -m ferramentas.corrigir_precos` |

Credenciais ficam no `.env` (`WEDROP_EMAIL`, `WEDROP_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

## Regras de segurança dos dados

- Antes de qualquer coleta, o `dados/data.json` é copiado para `dados/backups/`.
- Coleta **concluída** anteriormente: a próxima começa do zero (o `data.json` é reescrito).
- Coleta **interrompida** (erro, queda de sessão, internet): a próxima **retoma**, sem apagar nada e sem repetir produtos já salvos. O estado fica em `dados/estado_coleta.json`.
- Produto que abre sem nome e sem preço não é gravado: é relido e, se continuar vazio, fica para a próxima execução.
- Backups antigos são comprimidos (`.json.gz`), nunca apagados.
- Coleta parcial (`--categoria` ou `--limite`) só acrescenta dados e não muda o estado da coleta completa.

## Coleta diária incremental

`python -m wedrop diaria` não percorre o site inteiro. Antes de ler produtos, compara a quantidade de cada categoria (mostrada na página de categorias) com a última coleta, guardada na tabela `categories` do SQLite:

- **Quantidade igual** e todos os produtos da categoria já no `data.json`: compara **preço e saldo** de cada produto com o dia anterior. A listagem da categoria não é percorrida.
  - Preço e saldo iguais: nada é gravado, o registro fica como estava.
  - Só o preço mudou: grava o novo preço.
  - Saldo mudou: lê a aba **Histórico de Estoque** e grava as movimentações novas (vendas e entradas), que aparecem no painel.
- **Quantidade diferente**, categoria nunca coletada ou `data.json` com menos produtos que o site: percorre a **listagem inteira** da categoria para saber o que entrou e o que saiu.
  - Aumentou: produto novo (na listagem e ainda não salvo) é lido por inteiro.
  - Diminuiu: produto que acabou de sair da listagem esgotou. A página dele é lida por inteiro uma vez (últimas vendas no histórico e selo Indisponível), e ele continua salvo.
  - Produto que continua na listagem: mesma comparação de preço e saldo com o dia anterior.
  - Produto esgotado que a listagem mostra com selo **Indisponível** não é aberto (pulado). Quem está salvo como esgotado mas voltou ao selo **Disponível** é comparado e lido.
- Produto já esgotado (Indisponível) não é relido. A quantidade do site conta os esgotados, então a reposição só é vista quando a categoria é lida por inteiro.
- Se uma leitura de preço e saldo falhar, a categoria inteira é lida.

A coleta manual (`coletar`) continua completa.

## Estrutura

```
Drop/
├── wedrop/                 pacote principal
│   ├── config.py           caminhos, URLs e limites
│   ├── mapping.py          coleta completa (categorias → listagens → produtos → gravação)
│   ├── protection.py       coleta diária com novas tentativas
│   ├── cli.py              comandos `coletar` e `diaria`
│   ├── names.py            limpeza de nomes de produto
│   ├── scraping/           navegador, sessão, categorias, leitura do produto (funções puras em parsing.py e product_record.py)
│   └── storage/            data.json, estado da coleta, SQLite (painel) e Supabase
├── ferramentas/            reparos pontuais (corrigir_precos)
├── app_monitoramento_vendas.py   painel Streamlit
├── tests/                  testes unitários (python -m unittest discover -s tests -t .)
├── dados/                  data.json, banco SQLite, backups e sessão (não versionado)
├── logs/                   log da coleta
├── _arquivo/               código e documentos antigos, mantidos para consulta
└── configure_daily_task.ps1   registra a tarefa diária no Windows
```

## Testes

```
python -m unittest tests.test_scraping tests.test_data_file tests.test_storage
```

## Pendências conhecidas

- A listagem da categoria Cozinha chega a 1275 de 1276 produtos; o último ainda não foi identificado.
- A API `api.wedrop.com.br/v3/api/catalog/<id>` responde em cerca de 0,3 s (o navegador leva de 3 a 5 s por produto). Ainda não foi usada na coleta porque os campos precisam ser mapeados e conferidos antes.
