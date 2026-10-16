-- Views de referência para planejamento (Google Sheets, Argon, Looker Studio).
-- Rodar no SQL Editor do Supabase depois de supabase_schema.sql. Só leitura: a coleta
-- continua sendo a única que grava as tabelas.
-- Dias no fuso de São Paulo. Venda = movimentação do tipo 'sale' (quantidade positiva).

-- 1) Base: uma linha por produto e dia, com vendas e reposições.
create or replace view public.wedrop_vw_vendas_produto_dia as
select
    e.product_id,
    p.name as produto,
    p.category as categoria,
    p.sku,
    (e.event_at at time zone 'America/Sao_Paulo')::date as dia,
    coalesce(sum(e.quantity) filter (where e.event_kind = 'sale'), 0) as unidades_vendidas,
    count(*) filter (where e.event_kind = 'sale') as eventos_venda,
    coalesce(sum(e.quantity) filter (where e.event_kind = 'stock_in'), 0) as unidades_repostas
from public.wedrop_stock_events e
join public.wedrop_products p on p.product_id = e.product_id
where e.event_at is not null
group by e.product_id, p.name, p.category, p.sku, (e.event_at at time zone 'America/Sao_Paulo')::date;

-- 2) Por categoria e dia: volume vendido, quantos produtos venderam e reposições.
create or replace view public.wedrop_vw_vendas_categoria_dia as
select
    categoria,
    dia,
    sum(unidades_vendidas) as unidades_vendidas,
    count(*) filter (where unidades_vendidas > 0) as produtos_vendidos,
    sum(unidades_repostas) as unidades_repostas
from public.wedrop_vw_vendas_produto_dia
group by categoria, dia;

-- 3) Produtos mais vendidos por categoria, com posição nos últimos 7 e 30 dias
--    (dias encerrados em ontem + hoje, até a última coleta).
create or replace view public.wedrop_vw_top_produtos_categoria as
with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as dia
),
janela as (
    select
        v.product_id,
        v.produto,
        v.categoria,
        v.sku,
        sum(v.unidades_vendidas) filter (where v.dia > h.dia - 7) as unidades_7d,
        sum(v.unidades_vendidas) filter (where v.dia > h.dia - 30) as unidades_30d,
        count(*) filter (where v.unidades_vendidas > 0 and v.dia > h.dia - 30) as dias_com_venda_30d,
        max(v.dia) filter (where v.unidades_vendidas > 0) as ultimo_dia_venda
    from public.wedrop_vw_vendas_produto_dia v
    cross join hoje h
    where v.dia > h.dia - 30
    group by v.product_id, v.produto, v.categoria, v.sku
)
select
    j.categoria,
    row_number() over (partition by j.categoria order by j.unidades_30d desc, j.produto) as posicao_30d,
    row_number() over (partition by j.categoria order by coalesce(j.unidades_7d, 0) desc, j.produto) as posicao_7d,
    j.product_id,
    j.produto,
    j.sku,
    coalesce(j.unidades_7d, 0) as unidades_7d,
    coalesce(j.unidades_30d, 0) as unidades_30d,
    coalesce(j.dias_com_venda_30d, 0) as dias_com_venda_30d,
    j.ultimo_dia_venda,
    p.stock as estoque_atual,
    p.price as preco_atual,
    p.is_active as situacao
from janela j
join public.wedrop_products p on p.product_id = j.product_id
where coalesce(j.unidades_30d, 0) > 0;

-- Acesso: views do schema public herdam permissões padrão do Supabase (anon/authenticated).
-- Como as views rodam com o dono da tabela, o RLS não as protege: fecha-se o acesso aqui.
revoke all on public.wedrop_vw_vendas_produto_dia from anon, authenticated;
revoke all on public.wedrop_vw_vendas_categoria_dia from anon, authenticated;
revoke all on public.wedrop_vw_top_produtos_categoria from anon, authenticated;
grant select on public.wedrop_vw_vendas_produto_dia to service_role;
grant select on public.wedrop_vw_vendas_categoria_dia to service_role;
grant select on public.wedrop_vw_top_produtos_categoria to service_role;
