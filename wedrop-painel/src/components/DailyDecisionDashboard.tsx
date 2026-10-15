import React, { useState } from 'react';
import {
  Trophy,
  Flame,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  PackageCheck,
  Clock,
  Briefcase,
  Copy,
  Check,
  Sparkles,
  BarChart3,
  Layers,
  Minus,
  Tag,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import { Decision24hData } from '../services/dataService';
import { Product24hStats, ProductRecord } from '../types/wedrop';
import { formatDateTimeBR, formatInt } from '../utils/status';

interface DailyDecisionDashboardProps {
  decisionData: Decision24hData;
  onSelectCategory: (name: string) => void;
  onSelectProductForDetails: (product: ProductRecord) => void;
  onNavigateToPrices: () => void;
}

export const DailyDecisionDashboard: React.FC<DailyDecisionDashboardProps> = ({
  decisionData,
  onSelectCategory,
  onSelectProductForDetails,
  onNavigateToPrices,
}) => {
  const {
    top20Products,
    topCategories24h,
    totals24h,
    restockedProducts,
    soldProducts,
    priceAlerts,
  } = decisionData;

  // Second Business Model View Toggle
  const [rankingModel, setRankingModel] = useState<'comparativo_grafico' | 'oportunidades_loja'>('comparativo_grafico');
  const [copiedSku, setCopiedSku] = useState<string | null>(null);

  const handleCopySku = (sku: string) => {
    navigator.clipboard.writeText(sku);
    setCopiedSku(sku);
    setTimeout(() => setCopiedSku(null), 2000);
  };

  // Podium top 3 categories
  const top3 = topCategories24h.slice(0, 3);

  // Por categoria: quantos produtos venderam ontem e hoje, e a variação das unidades
  const soldByCategory = new Map<string, { soldYesterday: number; soldToday: number }>();
  for (const p of soldProducts) {
    const entry = soldByCategory.get(p.category) || { soldYesterday: 0, soldToday: 0 };
    if (p.salesYesterday > 0) entry.soldYesterday += 1;
    if (p.salesToday > 0) entry.soldToday += 1;
    soldByCategory.set(p.category, entry);
  }
  const categoryRanking = topCategories24h.map((c) => {
    const counts = soldByCategory.get(c.name) || { soldYesterday: 0, soldToday: 0 };
    const percent =
      c.salesYesterday > 0
        ? ((c.salesToday - c.salesYesterday) / c.salesYesterday) * 100
        : c.salesToday > 0
        ? 100
        : 0;
    return { ...c, ...counts, percent };
  });
  const categoriesWithSalesToday = categoryRanking.filter((c) => c.salesToday > 0).length;

  // Destaques: o que realmente está vendendo (nos dois dias), o que só saiu hoje e o que só saiu ontem
  const bothDaysAll = soldProducts
    .filter((p) => p.salesToday > 0 && p.salesYesterday > 0)
    .sort((a, b) => b.salesToday + b.salesYesterday - (a.salesToday + a.salesYesterday));
  const onlyTodayAll = soldProducts
    .filter((p) => p.salesToday > 0 && p.salesYesterday === 0)
    .sort((a, b) => b.salesToday - a.salesToday);
  const onlyYesterdayAll = soldProducts
    .filter((p) => p.salesYesterday > 0 && p.salesToday === 0)
    .sort((a, b) => b.salesYesterday - a.salesYesterday);
  const productsSoldToday = soldProducts.filter((p) => p.salesToday > 0).length;

  // Chart data for top 3 categories: Ontem vs Hoje
  const top3ChartData = top3.map((c) => ({
    name: c.name,
    'Ontem (24h ant.)': c.salesYesterday,
    'Hoje (Últimas 24h)': c.salesToday,
  }));

  // Chart data for Top 10 products: Ontem vs Hoje
  const top10ProductsChart = top20Products.slice(0, 10).map((p) => ({
    name: p.name.length > 20 ? p.name.substring(0, 20) + '...' : p.name,
    fullName: p.name,
    'Ontem': p.salesYesterday,
    'Hoje (24h)': p.salesToday,
  }));

  const renderHighlightList = (items: Product24hStats[], emptyText: string) =>
    items.length === 0 ? (
      <div className="text-center py-6 text-xs text-muted">{emptyText}</div>
    ) : (
      items.slice(0, 10).map((p, idx) => (
        <div
          key={p.product_id}
          className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-card-secondary border border-theme text-xs"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-muted">{idx + 1}º</span>
              <button
                type="button"
                onClick={() => onSelectProductForDetails(p)}
                className="font-medium text-theme hover:text-accent truncate text-left"
                title={p.name}
              >
                {p.name}
              </button>
            </div>
            <span className="text-[11px] text-muted">
              {p.category} · SKU: {p.sku || '—'}
            </span>
          </div>
          <div className="text-right shrink-0">
            <span className="block font-bold text-accent">{formatInt(p.salesToday)} hoje</span>
            <span className="block text-[11px] text-muted">{formatInt(p.salesYesterday)} ontem</span>
          </div>
        </div>
      ))
    );

  return (
    <div className="space-y-6">
      {/* 24h Executive Alert Banner */}
      <div className="bg-card border border-theme rounded-xl p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-accent flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> Leitura das Últimas 24 Horas (Rotina 00:00)
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-theme mt-1">
              Radar Diário de Tomada de Decisão
            </h2>
            <p className="text-xs text-muted mt-0.5 max-w-2xl">
              Comparativo automatizado de faturamento, novos lotes de estoque, produtos reativados e variação de preço para sua loja.
            </p>
            {decisionData.cutoffLabel && (
              <p className="text-[11px] font-semibold text-accent mt-1">
                Hoje até {decisionData.cutoffLabel} × ontem até o mesmo horário
              </p>
            )}
          </div>

          {/* Quick Metrics KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-card-secondary p-2.5 rounded-lg border border-theme text-center">
              <span className="text-[11px] font-semibold text-muted block">Vendas 24h</span>
              <span className="text-lg font-bold text-theme">{formatInt(totals24h.totalSoldToday)}</span>
              <span
                className={`text-[10px] font-bold block ${
                  totals24h.salesDiff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                }`}
              >
                {totals24h.salesDiff >= 0 ? '+' : ''}
                {formatInt(totals24h.salesDiff)} un. ({totals24h.salesPercentChange.toFixed(1)}%)
              </span>
            </div>

            <div className="bg-card-secondary p-2.5 rounded-lg border border-theme text-center">
              <span className="text-[11px] font-semibold text-muted block">Reposições</span>
              <span className="text-lg font-bold text-blue-600 dark:text-blue-400">
                {formatInt(totals24h.totalRestockedToday)}
              </span>
              <span className="text-[10px] text-muted block">{restockedProducts.length} itens repostos</span>
            </div>

            <div className="bg-card-secondary p-2.5 rounded-lg border border-theme text-center">
              <span className="text-[11px] font-semibold text-muted block">Categorias com venda</span>
              <span className="text-lg font-bold text-theme">
                {categoriesWithSalesToday} de {categoryRanking.length}
              </span>
              <span className="text-[10px] text-muted block">vendendo hoje</span>
            </div>

            <div className="bg-card-secondary p-2.5 rounded-lg border border-theme text-center">
              <span className="text-[11px] font-semibold text-muted block">Produtos vendidos</span>
              <span className="text-lg font-bold text-accent">{formatInt(productsSoldToday)}</span>
              <span className="text-[10px] text-muted block">
                {bothDaysAll.length} venderam nos dois dias
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Podium: Top 3 Categorias Campeãs */}
      <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-theme pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-amber-500" />
              <h3 className="text-base font-bold text-theme">
                Top 3 Categorias Líderes em Vendas (Últimas 24 Horas)
              </h3>
            </div>
            <p className="text-xs text-muted">
              As 3 categorias com maior saída no depósito. Acompanhe a quantidade disponível e o volume vendido.
            </p>
          </div>
        </div>

        {/* Podium Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {top3.map((cat, index) => {
            const medals = [
              { color: 'text-amber-500 border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20', label: '1º Lugar (Ouro)', rankBadge: 'bg-amber-500 text-white' },
              { color: 'text-slate-400 border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40', label: '2º Lugar (Prata)', rankBadge: 'bg-slate-400 text-white' },
              { color: 'text-amber-700 border-amber-600/30 bg-orange-50/60 dark:bg-orange-950/20', label: '3º Lugar (Bronze)', rankBadge: 'bg-amber-700 text-white' },
            ];
            const medal = medals[index];

            return (
              <div
                key={cat.name}
                className={`p-4 rounded-xl border transition-all ${medal.color} relative flex flex-col justify-between`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full ${medal.rankBadge}`}>
                      {medal.label}
                    </span>
                    <button
                      onClick={() => onSelectCategory(cat.name)}
                      className="text-xs font-semibold text-accent hover:underline flex items-center gap-0.5"
                    >
                      <span>Ver produtos</span>
                    </button>
                  </div>

                  <h4 className="text-base font-bold text-theme">{cat.name}</h4>

                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                    <div className="bg-card p-2 rounded-lg border border-theme">
                      <span className="text-[10px] text-muted block uppercase font-medium">Vendas 24h</span>
                      <span className="text-base font-bold text-accent">{formatInt(cat.salesToday)} un.</span>
                      <span
                        className={`text-[10px] font-semibold block ${
                          cat.salesDiff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                        }`}
                      >
                        {cat.salesDiff >= 0 ? `+${cat.salesDiff}` : cat.salesDiff} vs ontem
                      </span>
                    </div>

                    <div className="bg-card p-2 rounded-lg border border-theme">
                      <span className="text-[10px] text-muted block uppercase font-medium">Disponíveis</span>
                      <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">{cat.itemsCountToday} itens</span>
                      <span className="text-[10px] text-muted block">
                        {cat.itemsDiff > 0
                          ? `+${cat.itemsDiff} (novos/reposição)`
                          : cat.itemsDiff < 0
                          ? `${cat.itemsDiff} (esgotaram)`
                          : 'Estável'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-2 border-t border-theme/40 text-[11px] flex items-center justify-between text-muted">
                  <span>Reposição hoje:</span>
                  <span className="font-bold text-blue-600 dark:text-blue-400">{formatInt(cat.restockToday)} un.</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* O total de hoje inclui as categorias fora do pódio; sem esta linha, o pódio não soma o total */}
        {(() => {
          const others = categoryRanking.slice(3).filter((c) => c.salesToday > 0);
          const othersUnits = others.reduce((acc, c) => acc + c.salesToday, 0);
          if (others.length === 0) return null;
          return (
            <p className="text-[11px] text-muted">
              Demais {others.length} {others.length === 1 ? 'categoria' : 'categorias'} com venda: {formatInt(othersUnits)} un.
              {' · '}Total de hoje: {formatInt(totals24h.totalSoldToday)} un.
            </p>
          );
        })()}

        {/* Top 3 Comparison Bar Chart */}
        <div className="pt-2">
          <div className="text-xs font-semibold text-muted mb-2">
            Comparativo de Vendas das 3 Líderes: Ontem vs Hoje
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={top3ChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="Ontem (24h ant.)" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Hoje (Últimas 24h)" fill="var(--accent-color)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Categorias: quais saíram, ontem x hoje (todas as categorias) */}
      <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-2 border-b border-theme pb-3">
          <Layers className="w-5 h-5 text-accent" />
          <div>
            <h3 className="text-base font-bold text-theme">Categorias: vendas de ontem × hoje</h3>
            <p className="text-xs text-muted">
              Todas as categorias do catálogo, da que mais vendeu hoje para a que menos vendeu. Quem não teve venda aparece zerado.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto border border-theme rounded-lg">
          <table className="w-full text-xs text-left">
            <thead className="bg-card-secondary text-muted uppercase font-semibold border-b border-theme">
              <tr>
                <th className="px-3 py-2.5 text-center w-12">#</th>
                <th className="px-3.5 py-2.5">Categoria</th>
                <th className="px-3 py-2.5 text-right">Produtos que venderam ontem</th>
                <th className="px-3 py-2.5 text-right">Produtos que venderam hoje</th>
                <th className="px-3 py-2.5 text-right text-muted">Vendas ontem</th>
                <th className="px-3 py-2.5 text-right font-bold text-accent">Vendas hoje</th>
                <th className="px-3 py-2.5 text-right">Variação</th>
                <th className="px-3 py-2.5 text-right text-blue-600 dark:text-blue-400">Reposição hoje</th>
                <th className="px-3 py-2.5 text-center">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme text-theme">
              {categoryRanking.map((c, idx) => {
                const isUp = c.salesDiff > 0;
                const isDown = c.salesDiff < 0;

                return (
                  <tr key={c.name} className="hover-bg transition-colors">
                    <td className="px-3 py-2.5 text-center font-bold text-muted">{idx + 1}º</td>
                    <td className="px-3.5 py-2.5 font-bold text-theme whitespace-nowrap">{c.name}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{formatInt(c.soldYesterday)}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-theme">{formatInt(c.soldToday)}</td>
                    <td className="px-3 py-2.5 text-right text-muted whitespace-nowrap">{formatInt(c.salesYesterday)} un.</td>
                    <td className="px-3 py-2.5 text-right font-bold text-accent whitespace-nowrap">{formatInt(c.salesToday)} un.</td>
                    <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">
                      {isUp ? (
                        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                          <ArrowUpRight className="w-3.5 h-3.5" />+{c.salesDiff} ({c.percent.toFixed(0)}%)
                        </span>
                      ) : isDown ? (
                        <span className="inline-flex items-center gap-0.5 text-red-500">
                          <ArrowDownRight className="w-3.5 h-3.5" />{c.salesDiff} ({c.percent.toFixed(0)}%)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-muted">
                          <Minus className="w-3.5 h-3.5" />0
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-blue-600 dark:text-blue-400 whitespace-nowrap">
                      {c.restockToday > 0 ? `+${formatInt(c.restockToday)} un.` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => onSelectCategory(c.name)}
                        className="text-xs text-accent font-semibold hover:underline"
                      >
                        Ver produtos
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Destaques: o que está vendendo de verdade (ontem e hoje) */}
      <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-2 border-b border-theme pb-3">
          <Flame className="w-5 h-5 text-red-500" />
          <div>
            <h3 className="text-base font-bold text-theme">Destaques de venda: ontem e hoje</h3>
            <p className="text-xs text-muted">
              Quem vende nos dois dias tem giro de verdade. Os que saíram só hoje são novidade; os que saíram só ontem pararam de sair.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-emerald-700 dark:text-emerald-400">Vendem nos dois dias</span>
              <span className="text-muted font-medium">{bothDaysAll.length} produtos</span>
            </div>
            {renderHighlightList(bothDaysAll, 'Nenhum produto vendeu nos dois dias.')}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-accent">Saíram só hoje</span>
              <span className="text-muted font-medium">{onlyTodayAll.length} produtos</span>
            </div>
            {renderHighlightList(onlyTodayAll, 'Nenhum produto vendeu só hoje.')}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-muted">Saíram só ontem</span>
              <span className="text-muted font-medium">{onlyYesterdayAll.length} produtos</span>
            </div>
            {renderHighlightList(onlyYesterdayAll, 'Nenhum produto vendeu só ontem.')}
          </div>
        </div>
      </div>

      {/* Alertas de alteração de preço: ontem e hoje (o preço anterior não é guardado) */}
      <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between border-b border-theme pb-2.5">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-bold text-theme">Alertas de alteração de preço (ontem e hoje)</h3>
          </div>
          <span className="text-xs text-muted font-medium">{priceAlerts.length} produtos</span>
        </div>
        <p className="text-xs text-muted">
          Mostra quais produtos tiveram o preço alterado na coleta e o preço atual. O preço anterior não é guardado.
        </p>

        {priceAlerts.length === 0 ? (
          <div className="text-center py-6 text-xs text-muted">Nenhum preço foi alterado ontem ou hoje.</div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {priceAlerts.map((alert) => (
              <div
                key={alert.product.product_id}
                className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-card-secondary border border-theme text-xs"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onSelectProductForDetails(alert.product)}
                    className="font-medium text-theme hover:text-accent truncate block text-left"
                    title={alert.product.name}
                  >
                    {alert.product.name}
                  </button>
                  <span className="text-[11px] text-muted">
                    {alert.product.category} · alterado {alert.day} · {formatDateTimeBR(alert.changedAt)}
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <span className="block font-bold text-theme">{alert.product.price || '—'}</span>
                  <a
                    href={alert.product.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-accent hover:underline inline-flex items-center gap-0.5"
                  >
                    <span>Abrir</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top 20 Best Sellers in Last 24 Hours with 2 Distinct Model Views */}
      <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-theme pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-red-500" />
              <h3 className="text-base font-bold text-theme">
                Ranking dos 20 Produtos Mais Vendidos nas Últimas 24 Horas
              </h3>
            </div>
            <p className="text-xs text-muted">
              Identifique os itens com maior giro no distribuidor para colocar na sua loja virtual.
            </p>
          </div>

          {/* Model Switcher: Modelo Gráfico vs Modelo Empresarial */}
          <div className="flex items-center gap-1 bg-card-secondary p-1 rounded-lg border border-theme shrink-0 self-start sm:self-auto">
            <button
              onClick={() => setRankingModel('comparativo_grafico')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                rankingModel === 'comparativo_grafico'
                  ? 'bg-card text-theme shadow-2xs font-extrabold'
                  : 'text-muted hover:text-theme'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Modelo Gráfico (Ontem vs Hoje)</span>
            </button>
            <button
              onClick={() => setRankingModel('oportunidades_loja')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                rankingModel === 'oportunidades_loja'
                  ? 'bg-accent text-white shadow-2xs font-extrabold'
                  : 'text-muted hover:text-theme'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5" />
              <span>Modelo Empresarial (Giro & Loja)</span>
            </button>
          </div>
        </div>

        {/* MODELO 1: COMPARATIVO GRÁFICO */}
        {rankingModel === 'comparativo_grafico' ? (
          <>
            {/* Bar chart Top 10 Ontem vs Hoje */}
            <div className="h-56 w-full pt-1">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={top10ProductsChart} margin={{ top: 5, right: 20, left: 0, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                  <XAxis dataKey="name" angle={-20} textAnchor="end" tick={{ fontSize: 10 }} height={40} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(val, name) => [`${val} unidades`, name]}
                    labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar dataKey="Ontem" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Hoje (24h)" fill="var(--accent-color)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Interactive Top 20 Table */}
            <div className="overflow-x-auto border border-theme rounded-lg">
              <table className="w-full text-xs text-left">
                <thead className="bg-card-secondary text-muted uppercase font-semibold border-b border-theme">
                  <tr>
                    <th className="px-3 py-2.5 text-center w-12">#</th>
                    <th className="px-3.5 py-2.5">Produto</th>
                    <th className="px-3 py-2.5">Categoria</th>
                    <th className="px-3 py-2.5">Preço</th>
                    <th className="px-3 py-2.5 text-right font-bold text-accent">Vendas 24h</th>
                    <th className="px-3 py-2.5 text-right text-muted">Ontem</th>
                    <th className="px-3 py-2.5 text-right">Variação</th>
                    <th className="px-3 py-2.5 text-center">Status / Tag</th>
                    <th className="px-3 py-2.5 text-center">Ação Loja</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme text-theme">
                  {top20Products.map((p, idx) => {
                    const isPositive = p.salesDiff >= 0;

                    return (
                      <tr key={p.product_id} className="hover-bg transition-colors">
                        <td className="px-3 py-2 text-center font-bold text-muted">
                          {idx + 1}º
                        </td>
                        <td className="px-3.5 py-2 max-w-xs">
                          <button
                            type="button"
                            onClick={() => onSelectProductForDetails(p)}
                            className="font-medium text-theme hover:text-accent text-left line-clamp-1"
                            title={p.name}
                          >
                            {p.name}
                          </button>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectCategory(p.category)}
                            className="text-muted hover:text-accent font-medium"
                          >
                            {p.category}
                          </button>
                        </td>
                        <td className="px-3 py-2 font-semibold whitespace-nowrap">
                          {p.price || '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-accent whitespace-nowrap">
                          {formatInt(p.salesToday)} un.
                        </td>
                        <td className="px-3 py-2 text-right text-muted whitespace-nowrap">
                          {formatInt(p.salesYesterday)} un.
                        </td>
                        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-0.5 ${
                              isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                            }`}
                          >
                            {isPositive ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                            {isPositive ? `+${p.salesDiff}` : p.salesDiff} ({p.salesPercentChange.toFixed(0)}%)
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          {p.isTrending ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                              <Flame className="w-3 h-3 text-red-500 fill-current" /> Em Alta
                            </span>
                          ) : p.isReactivated ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-300 dark:border-emerald-700">
                              Reativado
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted">Estável</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-accent hover:opacity-80 font-bold text-[11px] bg-card px-2.5 py-1 rounded border border-theme shadow-2xs transition-all"
                            title="Abrir página direta no catálogo WeDrop"
                          >
                            <span>Ir para Loja</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          /* MODELO 2: EMPRESARIAL - OPORTUNIDADES PARA MINHA LOJA */
          <div className="space-y-3">
            <div className="bg-card-secondary p-3.5 rounded-xl border border-theme flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-accent" />
                <span className="text-xs font-bold text-theme">
                  Visão Empresarial: Produtos Validados com Alto Giro no Depósito
                </span>
              </div>
              <span className="text-[11px] text-muted">
                Estoque garantido para revenda imediata no dropshipping
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {top20Products.map((p, idx) => (
                <div
                  key={p.product_id}
                  className="bg-card p-4 rounded-xl border border-theme shadow-2xs hover:border-accent transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-1.5">
                        <span className="bg-accent text-white font-black text-xs px-2 py-0.5 rounded">
                          {idx + 1}º Mais Vendido
                        </span>
                        <span className="text-xs font-semibold text-muted">
                          {p.category}
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 px-2 py-0.5 rounded border border-emerald-300 dark:border-emerald-700">
                        Disponível ({p.stock || '0'} no estoque)
                      </span>
                    </div>

                    <h4
                      onClick={() => onSelectProductForDetails(p)}
                      className="font-bold text-theme hover:text-accent cursor-pointer line-clamp-2 text-sm mb-3"
                    >
                      {p.name}
                    </h4>

                    {/* Metricas de Giro */}
                    <div className="grid grid-cols-3 gap-2 text-center text-xs bg-card-secondary p-2.5 rounded-lg border border-theme mb-3">
                      <div>
                        <span className="text-[10px] text-muted uppercase font-semibold block">Vendas 24h</span>
                        <span className="text-sm font-black text-accent">{p.salesToday} un.</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted uppercase font-semibold block">Custo Depósito</span>
                        <span className="text-sm font-black text-theme">{p.price || '—'}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted uppercase font-semibold block">Saldo Depósito</span>
                        <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{p.real_balance || p.stock || '0'} un.</span>
                      </div>
                    </div>
                  </div>

                  {/* Ações Rápidas de Revenda */}
                  <div className="pt-2 border-t border-theme flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopySku(p.sku || p.name)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-muted hover:text-theme bg-card-secondary border border-theme rounded transition-colors"
                    >
                      {copiedSku === (p.sku || p.name) ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-500" />
                          <span className="text-emerald-600 dark:text-emerald-400">SKU Copiado!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copiar SKU ({p.sku || 'ID'})</span>
                        </>
                      )}
                    </button>

                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-accent bg-accent-hover rounded shadow-xs transition-colors"
                    >
                      <span>Abrir na Minha Loja / WeDrop</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reposições recebidas nas últimas 24h */}
      <div className="grid grid-cols-1 gap-5">
        {/* Lotes Repostos nas últimas 24h */}
        <div className="bg-card border border-theme rounded-xl p-5 shadow-xs space-y-3">
          <div className="flex items-center justify-between border-b border-theme pb-2.5">
            <div className="flex items-center gap-2">
              <PackageCheck className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-bold text-theme">
                Reposições Recebidas ({restockedProducts.length} itens)
              </h3>
            </div>
            <span className="text-xs text-blue-600 dark:text-blue-400 font-bold">
              +{formatInt(totals24h.totalRestockedToday)} unidades no depósito
            </span>
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {restockedProducts.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted">
                Nenhuma reposição gravada nas últimas 24 horas.
              </div>
            ) : (
              restockedProducts.map((p) => (
                <div
                  key={p.product_id}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-card-secondary border border-theme text-xs"
                >
                  <div className="min-w-0 pr-2">
                    <button
                      onClick={() => onSelectProductForDetails(p)}
                      className="font-medium text-theme hover:text-accent truncate block text-left"
                    >
                      {p.name}
                    </button>
                    <span className="text-[11px] text-muted">
                      {p.category} · SKU: {p.sku || '—'}
                    </span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-bold text-blue-600 dark:text-blue-400 block">
                      +{p.restockToday} un.
                    </span>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-accent hover:underline flex items-center gap-0.5 justify-end"
                    >
                      <span>Abrir</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
