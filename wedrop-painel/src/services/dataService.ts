import {
  CategoryRecord,
  ProductRecord,
  StockEventRecord,
  CategorySummary,
  ProductWithActivity,
  DailyActivityRow,
  TopProductDailyRow,
  DataSourceConfig,
  Product24hStats,
  Category24hComparison,
  NewProductsData,
  NewProductWithSales,
  ProductStockMonitoring,
  ProductStockSnapshot,
} from '../types/wedrop';
import {
  CATEGORY_NAMES,
  getStatusBucket,
  generateDaysRange,
  formatDayToDDMM,
  getLocalDateString,
  getPastDate,
  parsePriceNumber,
} from '../utils/status';
import { APP_TIME_ZONE, clockLabel, eventDayKey, daysBetween, dayKeyFromDate, minutesOfDaySP, shiftDayKey, todayKey } from '../utils/dates';

const SNAPSHOT_URL = '/api/snapshot';

interface SnapshotResponse {
  categories: CategoryRecord[];
  products: ProductRecord[];
  stock_events: StockEventRecord[];
  stock_snapshots: ProductStockSnapshot[];
  fetched_at: string;
}

/** Movimentação com o dia (AAAA-MM-DD) já calculado no fuso de São Paulo. */
type DatedStockEvent = StockEventRecord & { day: string };

/** Produto cujo preço mudou ontem ou hoje. Mostra só que mudou, sem o preço anterior. */
export interface PriceAlertRow {
  product: ProductRecord;
  day: 'hoje' | 'ontem';
  changedAt: string;
}

export interface Decision24hData {
  /** Hora da última coleta (HH:MM, São Paulo): hoje vai até aqui e ontem até o mesmo horário. */
  cutoffLabel: string | null;
  top20Products: Product24hStats[];
  priceAlerts: PriceAlertRow[];
  topCategories24h: Category24hComparison[];
  restockedProducts: Product24hStats[];
  reactivatedProducts: Product24hStats[];
  outOfStockProducts: Product24hStats[];
  /** Produtos com venda ontem ou hoje. */
  soldProducts: Product24hStats[];
  totals24h: {
    totalSoldToday: number;
    totalSoldYesterday: number;
    salesDiff: number;
    salesPercentChange: number;
    totalRestockedToday: number;
    totalPriceIncreases: number;
    totalPriceDecreases: number;
    totalReactivated: number;
    totalOutOfStock: number;
  };
}

const inRange = (day: string, start: string, end: string) => day >= start && day <= end;

/** Desempate por nome sem diferenciar maiúsculas, como o ORDER BY ... COLLATE NOCASE do Python. */
const byNameNoCase = (a: string, b: string) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

const parseStockCount = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const normalized = value.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
  const match = normalized.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const quantity = Number(match[0].replace(',', '.'));
  return Number.isFinite(quantity) ? Math.trunc(quantity) : null;
};

/**
 * Dados do painel. Tudo vem do Supabase, lido pela função /api/snapshot no servidor.
 * As consultas seguem as do SalesRepository (Drop/wedrop/storage/sqlite_repository.py).
 */
class DataService {
  private categories: CategoryRecord[] = [];
  private products: ProductRecord[] = [];
  private stockEvents: DatedStockEvent[] = [];
  private stockSnapshots: ProductStockSnapshot[] = [];
  private config: DataSourceConfig = {
    lastFetchedAt: null,
    isConnected: false,
    statusMessage: 'Aguardando a primeira leitura do Supabase...',
  };
  private inFlight: Promise<boolean> | null = null;

  public getConfig(): DataSourceConfig {
    return { ...this.config };
  }

  /** Lê o Supabase pelo servidor. Se a leitura falhar, mantém os dados da última leitura boa. */
  public loadFromApi(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.fetchSnapshot().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchSnapshot(): Promise<boolean> {
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        const snapshot = body as SnapshotResponse;
        if (!snapshot || !Array.isArray(snapshot.categories) || !Array.isArray(snapshot.products)) {
          // Ex.: rodando só o Vite, sem a função /api/snapshot, a resposta é a página HTML
          throw new Error('a função /api/snapshot não respondeu com os dados (verifique o deploy da Vercel)');
        }
        this.categories = snapshot.categories;
        this.products = snapshot.products;
        this.stockEvents = snapshot.stock_events.flatMap((evt) => {
          const day = eventDayKey(evt.event_at, evt.event_at_raw);
          return day ? [{ ...evt, day }] : [];
        });
        this.stockSnapshots = snapshot.stock_snapshots;

        const readAt = new Date(snapshot.fetched_at).toLocaleTimeString('pt-BR', {
          timeZone: APP_TIME_ZONE,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        this.config = {
          lastFetchedAt: readAt,
          isConnected: true,
          statusMessage: `Fonte: Supabase (lido às ${readAt})`,
        };
        return true;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error('Erro desconhecido');
        console.error(`Tentativa ${attempt + 1}/${MAX_RETRIES} falhou:`, lastError);
        
        // Só faz retry se for erro de rede ou timeout (não se for erro HTTP)
        const shouldRetry = lastError.message.includes('HTTP') === false || 
                          lastError.message.includes('504') || 
                          lastError.message.includes('502') ||
                          lastError.message.includes('503');
        
        if (!shouldRetry || attempt === MAX_RETRIES - 1) {
          break;
        }
        
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Todas as tentativas falharam
    const msg = lastError ? lastError.message : 'Erro desconhecido';
    this.config = {
      ...this.config,
      isConnected: false,
      statusMessage: `Não foi possível ler os dados: ${msg} (após ${MAX_RETRIES} tentativas)`,
    };
    return false;
  }

  /**
   * Quando a última coleta passou pelo catálogo. Categorias são gravadas em toda execução;
   * produtos só são gravados quando mudam, então não servem para saber a hora da coleta.
   */
  public getLastCollectionAt(): string | null {
    let latest: number | null = null;
    for (const row of this.categories) {
      const time = Date.parse(row.updated_at);
      if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }

  public getProductsCount(): number {
    return this.products.length;
  }

  public getCategoriesList(): CategoryRecord[] {
    return this.categories;
  }

  public getProductsList(): ProductRecord[] {
    return this.products;
  }

  public getNewProductsData(days: number): NewProductsData {
    const now = new Date();
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    const today = todayKey();
    const availableProducts = this.products.filter(
      (product) => getStatusBucket(product.is_active, product.availability) === 'Ativos'
    );
    const productsWithoutFirstSeen = availableProducts.filter((product) => !product.first_seen_at);
    const cohort = availableProducts.flatMap((product) => {
      if (!product.first_seen_at) return [];
      const firstSeenTime = Date.parse(product.first_seen_at);
      if (Number.isNaN(firstSeenTime) || firstSeenTime < cutoff || firstSeenTime > now.getTime()) return [];
      const firstSeenDay = dayKeyFromDate(new Date(firstSeenTime));
      const age = Math.max(
        0,
        Math.floor(
          (Date.UTC(
            Number(today.slice(0, 4)),
            Number(today.slice(5, 7)) - 1,
            Number(today.slice(8, 10))
          ) -
            Date.UTC(
              Number(firstSeenDay.slice(0, 4)),
              Number(firstSeenDay.slice(5, 7)) - 1,
              Number(firstSeenDay.slice(8, 10))
            )) /
            (24 * 60 * 60 * 1000)
        )
      );
      return [{ product, firstSeenTime, firstSeenDay, age }];
    });
    const firstSeenDays = new Map(cohort.map(({ product, firstSeenDay }) => [product.product_id, firstSeenDay]));
    const sales = new Map<string, { units: number; lastSaleAt: string | null; lastSaleDay: string | null }>();

    for (const event of this.stockEvents) {
      const firstSeenDay = firstSeenDays.get(event.product_id);
      if (
        event.event_kind !== 'sale' ||
        !firstSeenDay ||
        event.day < firstSeenDay ||
        event.day > today
      ) {
        continue;
      }
      const current = sales.get(event.product_id) || { units: 0, lastSaleAt: null, lastSaleDay: null };
      const eventTime = event.event_at || event.event_at_raw || null;
      sales.set(event.product_id, {
        units: current.units + event.quantity,
        lastSaleAt: !current.lastSaleDay || event.day >= current.lastSaleDay
          ? eventTime
          : current.lastSaleAt,
        lastSaleDay: !current.lastSaleDay || event.day >= current.lastSaleDay
          ? event.day
          : current.lastSaleDay,
      });
    }

    const products: NewProductWithSales[] = cohort
      .map(({ product, firstSeenTime, age }) => {
        const activity = sales.get(product.product_id);
        return {
          ...product,
          first_seen_at: new Date(firstSeenTime).toISOString(),
          days_since_first_seen: age,
          units_sold_since_first_seen: activity?.units || 0,
          last_sale_at: activity?.lastSaleAt || null,
        };
      })
      .sort(
        (a, b) =>
          Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at) ||
          byNameNoCase(a.name, b.name)
      );

    const soldProducts = products.filter((product) => product.units_sold_since_first_seen > 0).length;
    const weekStart = shiftDayKey(today, -6);
    const snapshotsByProduct = new Map<string, ProductStockSnapshot[]>();
    const snapshotCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const snapshot of this.stockSnapshots) {
      if (Date.parse(snapshot.observed_at) < snapshotCutoff) continue;
      const history = snapshotsByProduct.get(snapshot.product_id) || [];
      history.push(snapshot);
      snapshotsByProduct.set(snapshot.product_id, history);
    }
    const salesLast7Days = new Map<string, { units: number; lastSaleAt: string | null }>();
    for (const event of this.stockEvents) {
      if (event.event_kind !== 'sale') continue;
      const current = salesLast7Days.get(event.product_id) || { units: 0, lastSaleAt: null };
      const eventAt = event.event_at || event.event_at_raw || null;
      if (event.day >= weekStart && event.day <= today) {
        current.units += event.quantity;
      }
      if (!current.lastSaleAt || (eventAt && Date.parse(eventAt) > Date.parse(current.lastSaleAt))) {
        current.lastSaleAt = eventAt;
      }
      salesLast7Days.set(event.product_id, current);
    }
    const currentProducts = new Map(this.products.map((product) => [product.product_id, product]));
    const stockMonitoring: ProductStockMonitoring[] = [];
    for (const [productId, snapshots] of snapshotsByProduct) {
      const product = currentProducts.get(productId);
      if (!product) continue;
      snapshots.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      const latest = snapshots[snapshots.length - 1];
      const previous = snapshots.length > 1 ? snapshots[0] : null;
      const currentStock = parseStockCount(latest.real_balance) ?? parseStockCount(latest.stock);
      const previousStock = previous
        ? parseStockCount(previous.real_balance) ?? parseStockCount(previous.stock)
        : null;
      const sales = salesLast7Days.get(productId) || { units: 0, lastSaleAt: null };
      const status = getStatusBucket(latest.is_active, latest.availability);
      const unavailable = latest.is_listed === false || status === 'Inativos' || currentStock === 0;
      const hadRecentUnavailableSnapshot = snapshots.some((snapshot) =>
        snapshot.is_listed === false ||
        getStatusBucket(snapshot.is_active, snapshot.availability) === 'Inativos' ||
        (parseStockCount(snapshot.real_balance) ?? parseStockCount(snapshot.stock)) === 0
      );
      const hadRecentCatalogRemoval = snapshots.some((snapshot) => snapshot.is_listed === false);
      let situation: ProductStockMonitoring['situation'] | null = null;
      if (latest.is_listed === false) {
        situation = 'Saiu do catálogo';
      } else if (unavailable) {
        situation = sales.units > 0 ? 'Esgotado com vendas' : 'Esgotado sem vendas';
      } else if (hadRecentUnavailableSnapshot) {
        situation = hadRecentCatalogRemoval ? 'Voltou ao catálogo' : 'Reposto';
      } else if (currentStock !== null && previousStock !== null && currentStock < previousStock) {
        situation = 'Saldo em queda';
      } else if (currentStock !== null && currentStock > 0 && sales.units === 0) {
        situation = 'Sem vendas há 7 dias';
      }
      if (!situation) continue;
      stockMonitoring.push({
        ...product,
        currentStock,
        previousStock,
        unitsSoldLast7Days: sales.units,
        lastSaleAt: sales.lastSaleAt,
        observedAt: latest.observed_at,
        situation,
        stock: latest.stock || product.stock,
        real_balance: latest.real_balance || product.real_balance,
        availability: latest.availability || product.availability,
        is_active: latest.is_active || product.is_active,
      });
    }
    stockMonitoring.sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || byNameNoCase(a.name, b.name)
    );
    return {
      totalAvailable: availableProducts.length,
      products,
      stockMonitoring,
      soldProducts,
      unsoldProducts: products.length - soldProducts,
      unitsSoldSinceEntry: products.reduce(
        (total, product) => total + product.units_sold_since_first_seen,
        0
      ),
      missingFirstSeenCount: productsWithoutFirstSeen.length,
      recentlyUnavailableCount: stockMonitoring.filter(
        (product) =>
          product.situation === 'Esgotado com vendas' ||
          product.situation === 'Esgotado sem vendas' ||
          product.situation === 'Saiu do catálogo'
      ).length,
      decliningStockCount: stockMonitoring.filter((product) => product.situation === 'Saldo em queda').length,
      noRecentSalesCount: stockMonitoring.filter((product) => product.situation === 'Sem vendas há 7 dias').length,
      stockTrackingReady: this.stockSnapshots.length > 0,
    };
  }

  public getStockEventsList(): StockEventRecord[] {
    return this.stockEvents;
  }

  // 24H Decision Analysis: D0 (Today) vs D-1 (Yesterday)
  public get24hDecisionData(): Decision24hData {
    const todayStr = getLocalDateString();
    const yesterdayStr = getPastDate(1);

    // Hoje ainda está em andamento: a leitura vai até a última coleta. Ontem entra só até o
    // mesmo horário; senão a comparação põe um dia parcial contra um dia inteiro.
    const cutoffIso = this.getLastCollectionAt();
    const cutoffDate = cutoffIso ? new Date(cutoffIso) : null;
    const cutoffMinutes = cutoffDate ? minutesOfDaySP(cutoffDate) : null;
    const cutoffLabel = cutoffDate && cutoffMinutes !== null ? clockLabel(cutoffDate) : null;
    const withinCutoff = (evt: DatedStockEvent): boolean => {
      if (cutoffMinutes === null) return true;
      // Movimentação sem hora (só a data do texto do site) conta no dia inteiro
      const eventMinutes = evt.event_at ? minutesOfDaySP(new Date(evt.event_at)) : null;
      return eventMinutes === null || eventMinutes <= cutoffMinutes;
    };

    // Map sales & restocks for today and yesterday
    const todaySales = new Map<string, number>();
    const todayRestock = new Map<string, number>();
    const yestSales = new Map<string, number>();
    const yestRestock = new Map<string, number>();

    for (const evt of this.stockEvents) {
      if (!withinCutoff(evt)) continue;
      if (evt.day === todayStr) {
        if (evt.event_kind === 'sale') {
          todaySales.set(evt.product_id, (todaySales.get(evt.product_id) || 0) + evt.quantity);
        } else if (evt.event_kind === 'stock_in') {
          todayRestock.set(evt.product_id, (todayRestock.get(evt.product_id) || 0) + evt.quantity);
        }
      } else if (evt.day === yesterdayStr) {
        if (evt.event_kind === 'sale') {
          yestSales.set(evt.product_id, (yestSales.get(evt.product_id) || 0) + evt.quantity);
        } else if (evt.event_kind === 'stock_in') {
          yestRestock.set(evt.product_id, (yestRestock.get(evt.product_id) || 0) + evt.quantity);
        }
      }
    }

    // Process all products
    const productStatsList: Product24hStats[] = [];
    const restockedList: Product24hStats[] = [];
    const reactivatedList: Product24hStats[] = [];
    const outOfStockList: Product24hStats[] = [];
    let totalPriceIncreases = 0;
    let totalPriceDecreases = 0;

    for (const prod of this.products) {
      const sToday = todaySales.get(prod.product_id) || 0;
      const sYest = yestSales.get(prod.product_id) || 0;
      const sDiff = sToday - sYest;
      const sPercent = sYest > 0 ? ((sToday - sYest) / sYest) * 100 : (sToday > 0 ? 100 : 0);
      const rToday = todayRestock.get(prod.product_id) || 0;
      const rYest = yestRestock.get(prod.product_id) || 0;

      if (prod.price && prod.previous_price) {
        const priceDiff = parsePriceNumber(prod.price) - parsePriceNumber(prod.previous_price);
        if (priceDiff > 0.05) totalPriceIncreases += 1;
        else if (priceDiff < -0.05) totalPriceDecreases += 1;
      }

      const isTrending = sToday >= 5 && (sPercent >= 30 || sYest === 0);
      const isReactivated = prod.was_active_yesterday === false && prod.is_active === 'Ativo';
      const isOutOfStock = (prod.stock === '0' || !prod.stock || prod.is_active === 'Inativo') && (prod.was_active_yesterday !== false);

      const stat: Product24hStats = {
        ...prod,
        salesToday: sToday,
        salesYesterday: sYest,
        salesDiff: sDiff,
        salesPercentChange: sPercent,
        restockToday: rToday,
        restockYesterday: rYest,
        isTrending,
        isReactivated,
        isOutOfStockNow: isOutOfStock,
      };

      productStatsList.push(stat);

      if (rToday > 0) restockedList.push(stat);
      if (isReactivated) reactivatedList.push(stat);
      if (isOutOfStock && (sToday > 0 || prod.was_active_yesterday)) outOfStockList.push(stat);
    }

    // Top 20 products 24h
    const top20Products = [...productStatsList]
      .filter((p) => p.salesToday > 0 || p.salesYesterday > 0)
      .sort((a, b) => b.salesToday - a.salesToday || b.salesYesterday - a.salesYesterday)
      .slice(0, 20);

    // Categories comparison for 24h
    const catCompMap = new Map<string, {
      salesToday: number;
      salesYesterday: number;
      restockToday: number;
      itemsCountToday: number;
      itemsCountYesterday: number;
      category_url?: string;
    }>();

    for (const name of CATEGORY_NAMES) {
      const catMeta = this.categories.find((c) => c.name === name);
      catCompMap.set(name, {
        salesToday: 0,
        salesYesterday: 0,
        restockToday: 0,
        itemsCountToday: 0,
        itemsCountYesterday: 0,
        category_url: catMeta?.category_url,
      });
    }

    for (const p of productStatsList) {
      let entry = catCompMap.get(p.category);
      if (!entry) {
        entry = {
          salesToday: 0,
          salesYesterday: 0,
          restockToday: 0,
          itemsCountToday: 0,
          itemsCountYesterday: 0,
        };
        catCompMap.set(p.category, entry);
      }

      entry.salesToday += p.salesToday;
      entry.salesYesterday += p.salesYesterday;
      entry.restockToday += p.restockToday;

      if (p.is_active === 'Ativo') {
        entry.itemsCountToday += 1;
      }
      if (p.was_active_yesterday !== false) {
        entry.itemsCountYesterday += 1;
      }
    }

    const categories24hList: Category24hComparison[] = [];
    catCompMap.forEach((val, name) => {
      const sDiff = val.salesToday - val.salesYesterday;
      const iDiff = val.itemsCountToday - val.itemsCountYesterday;
      let reason: 'new_products' | 'restock' | 'out_of_stock' | 'stable' = 'stable';
      if (iDiff > 0) {
        reason = val.restockToday > 0 ? 'restock' : 'new_products';
      } else if (iDiff < 0) {
        reason = 'out_of_stock';
      }

      categories24hList.push({
        name,
        category_url: val.category_url,
        salesToday: val.salesToday,
        salesYesterday: val.salesYesterday,
        salesDiff: sDiff,
        restockToday: val.restockToday,
        itemsCountToday: val.itemsCountToday,
        itemsCountYesterday: val.itemsCountYesterday,
        itemsDiff: iDiff,
        itemsReason: reason,
        rank: 0, // will rank below
      });
    });

    categories24hList.sort((a, b) => b.salesToday - a.salesToday);
    categories24hList.forEach((c, idx) => {
      c.rank = idx + 1;
    });

    // Summary 24h Totals
    const totalSoldToday = categories24hList.reduce((acc, c) => acc + c.salesToday, 0);
    const totalSoldYesterday = categories24hList.reduce((acc, c) => acc + c.salesYesterday, 0);
    const salesDiff = totalSoldToday - totalSoldYesterday;
    const salesPercentChange = totalSoldYesterday > 0
      ? ((totalSoldToday - totalSoldYesterday) / totalSoldYesterday) * 100
      : (totalSoldToday > 0 ? 100 : 0);
    const totalRestockedToday = categories24hList.reduce((acc, c) => acc + c.restockToday, 0);

    // Alertas de preço: alteração registrada pela coleta de hoje ou de ontem
    const priceAlerts: PriceAlertRow[] = [];
    for (const prod of this.products) {
      if (!prod.price_changed_at) continue;
      const changed = new Date(prod.price_changed_at);
      if (Number.isNaN(changed.getTime())) continue;
      const day = dayKeyFromDate(changed);
      if (day !== todayStr && day !== yesterdayStr) continue;
      priceAlerts.push({
        product: prod,
        day: day === todayStr ? 'hoje' : 'ontem',
        changedAt: prod.price_changed_at,
      });
    }
    priceAlerts.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));

    return {
      cutoffLabel,
      top20Products,
      priceAlerts,
      topCategories24h: categories24hList,
      restockedProducts: restockedList.sort((a, b) => b.restockToday - a.restockToday),
      reactivatedProducts: reactivatedList,
      outOfStockProducts: outOfStockList,
      soldProducts: productStatsList.filter((p) => p.salesToday > 0 || p.salesYesterday > 0),
      totals24h: {
        totalSoldToday,
        totalSoldYesterday,
        salesDiff,
        salesPercentChange,
        totalRestockedToday,
        totalPriceIncreases,
        totalPriceDecreases,
        totalReactivated: reactivatedList.length,
        totalOutOfStock: outOfStockList.length,
      },
    };
  }

  public getCategoryActivity(startDateStr: string, endDateStr: string): CategorySummary[] {
    const productEventsMap = new Map<string, { sold: number; restocked: number }>();
    for (const evt of this.stockEvents) {
      if (inRange(evt.day, startDateStr, endDateStr)) {
        const curr = productEventsMap.get(evt.product_id) || { sold: 0, restocked: 0 };
        if (evt.event_kind === 'sale') {
          curr.sold += evt.quantity;
        } else if (evt.event_kind === 'stock_in') {
          curr.restocked += evt.quantity;
        }
        productEventsMap.set(evt.product_id, curr);
      }
    }

    const catMap = new Map<string, {
      expected_products: number | null;
      mapped_products: number;
      units_sold: number;
      units_restocked: number;
      active_products: number;
      inactive_products: number;
      products_without_status: number;
      category_url?: string;
    }>();

    for (const name of CATEGORY_NAMES) {
      const catMeta = this.categories.find((c) => c.name === name);
      catMap.set(name, {
        expected_products: catMeta ? catMeta.expected_products : null,
        mapped_products: catMeta ? catMeta.mapped_products : 0,
        units_sold: 0,
        units_restocked: 0,
        active_products: 0,
        inactive_products: 0,
        products_without_status: 0,
        category_url: catMeta?.category_url,
      });
    }

    for (const prod of this.products) {
      let catEntry = catMap.get(prod.category);
      if (!catEntry) {
        catEntry = {
          expected_products: null,
          mapped_products: 0,
          units_sold: 0,
          units_restocked: 0,
          active_products: 0,
          inactive_products: 0,
          products_without_status: 0,
        };
        catMap.set(prod.category, catEntry);
      }

      const bucket = getStatusBucket(prod.is_active, prod.availability);
      if (bucket === 'Ativos') catEntry.active_products += 1;
      else if (bucket === 'Inativos') catEntry.inactive_products += 1;
      else catEntry.products_without_status += 1;

      const act = productEventsMap.get(prod.product_id);
      if (act) {
        catEntry.units_sold += act.sold;
        catEntry.units_restocked += act.restocked;
      }
    }

    const summaries: CategorySummary[] = [];
    catMap.forEach((val, name) => {
      summaries.push({
        name,
        category_url: val.category_url,
        expected_products: val.expected_products,
        mapped_products: val.mapped_products,
        units_sold: val.units_sold,
        units_restocked: val.units_restocked,
        active_products: val.active_products,
        inactive_products: val.inactive_products,
        products_without_status: val.products_without_status,
      });
    });

    return summaries;
  }

  public getProductsForCategory(
    categoryName: string,
    startDateStr: string,
    endDateStr: string
  ): ProductWithActivity[] {
    const eventCounts = new Map<string, { sold: number; restocked: number }>();
    for (const evt of this.stockEvents) {
      if (inRange(evt.day, startDateStr, endDateStr)) {
        const curr = eventCounts.get(evt.product_id) || { sold: 0, restocked: 0 };
        if (evt.event_kind === 'sale') curr.sold += evt.quantity;
        else if (evt.event_kind === 'stock_in') curr.restocked += evt.quantity;
        eventCounts.set(evt.product_id, curr);
      }
    }

    const categoryProducts = this.products.filter((p) => p.category === categoryName);

    return categoryProducts.map((p) => {
      const act = eventCounts.get(p.product_id) || { sold: 0, restocked: 0 };
      return {
        ...p,
        units_sold: act.sold,
        units_restocked: act.restocked,
        status_bucket: getStatusBucket(p.is_active, p.availability),
      };
    });
  }

  public getDailyActivity(
    startDateStr: string,
    endDateStr: string,
    selectedCategory?: string | null
  ): DailyActivityRow[] {
    const days = generateDaysRange(startDateStr, endDateStr);
    const dayMap = new Map<string, { sold: number; restocked: number }>();

    for (const day of days) {
      dayMap.set(day, { sold: 0, restocked: 0 });
    }

    const allowedProductIds = selectedCategory
      ? new Set(
          this.products
            .filter((p) => p.category === selectedCategory)
            .map((p) => p.product_id)
        )
      : null;

    for (const evt of this.stockEvents) {
      if (allowedProductIds && !allowedProductIds.has(evt.product_id)) {
        continue;
      }
      if (dayMap.has(evt.day)) {
        const entry = dayMap.get(evt.day)!;
        if (evt.event_kind === 'sale') entry.sold += evt.quantity;
        else if (evt.event_kind === 'stock_in') entry.restocked += evt.quantity;
      }
    }

    return days.map((day) => {
      const entry = dayMap.get(day) || { sold: 0, restocked: 0 };
      return {
        day,
        dayLabel: formatDayToDDMM(day),
        units_sold: entry.sold,
        units_restocked: entry.restocked,
      };
    });
  }

  public getTopProductsDaily(
    startDateStr: string,
    endDateStr: string,
    selectedCategory: string | null = null,
    limit: number = 100
  ): TopProductDailyRow[] {
    const days = daysBetween(startDateStr, endDateStr);

    const productTotals = new Map<
      string,
      {
        total_sold: number;
        total_restocked: number;
        daily: Record<string, number>;
      }
    >();

    const candidateProducts = selectedCategory
      ? this.products.filter((p) => p.category === selectedCategory)
      : this.products;

    const prodLookup = new Map(candidateProducts.map((p) => [p.product_id, p]));

    for (const evt of this.stockEvents) {
      if (!prodLookup.has(evt.product_id)) continue;
      if (!inRange(evt.day, startDateStr, endDateStr)) continue;

      let entry = productTotals.get(evt.product_id);
      if (!entry) {
        entry = {
          total_sold: 0,
          total_restocked: 0,
          daily: Object.fromEntries(days.map((d) => [d, 0])),
        };
        productTotals.set(evt.product_id, entry);
      }

      if (evt.event_kind === 'sale') {
        entry.total_sold += evt.quantity;
        if (entry.daily[evt.day] !== undefined) {
          entry.daily[evt.day] += evt.quantity;
        }
      } else if (evt.event_kind === 'stock_in') {
        entry.total_restocked += evt.quantity;
      }
    }

    const rows: TopProductDailyRow[] = [];
    productTotals.forEach((val, pId) => {
      const p = prodLookup.get(pId);
      if (p && val.total_sold + val.total_restocked > 0) {
        rows.push({
          product_id: p.product_id,
          name: p.name,
          category: p.category,
          url: p.url,
          total_sold: val.total_sold,
          total_restocked: val.total_restocked,
          daily_sales: val.daily,
        });
      }
    });

    rows.sort(
      (a, b) =>
        b.total_sold - a.total_sold ||
        b.total_restocked - a.total_restocked ||
        byNameNoCase(a.name, b.name)
    );
    return rows.slice(0, limit);
  }

  public getTopProductsOverall(
    startDateStr: string,
    endDateStr: string,
    limit: number = 20
  ): (ProductRecord & { units_sold: number })[] {
    const soldMap = new Map<string, number>();
    for (const evt of this.stockEvents) {
      if (evt.event_kind === 'sale' && inRange(evt.day, startDateStr, endDateStr)) {
        soldMap.set(evt.product_id, (soldMap.get(evt.product_id) || 0) + evt.quantity);
      }
    }

    const withSales = this.products
      .map((p) => ({
        ...p,
        units_sold: soldMap.get(p.product_id) || 0,
      }))
      .filter((p) => p.units_sold > 0)
      .sort((a, b) => b.units_sold - a.units_sold || byNameNoCase(a.name, b.name));

    return withSales.slice(0, limit);
  }

  public getProductsWithoutStatus(): ProductRecord[] {
    return this.products.filter(
      (p) => getStatusBucket(p.is_active, p.availability) === 'Sem status'
    );
  }
}

export const dataService = new DataService();
