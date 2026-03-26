import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, Check, ChefHat, Clock, Copy, ExternalLink, LogOut, Moon, Play, Plus, Printer, QrCode, Receipt, Save, Sparkles, Sun, Trash2, Upload, X } from 'lucide-react';
import { apiRequest, isAuthError } from '../lib/api';
import { RESTAURANT_NAME } from '../lib/config';
import {
  normalizeVenueSettings,
  prepareVenueSettingsPayload,
  validateVenueSettingsForm,
} from '../lib/venueSettings';
import {
  buildHistoryQuery,
  DEFAULT_HISTORY_FILTERS,
  formatHistoryMinutes,
  formatHistoryPaymentMethod,
  HISTORY_PAYMENT_METHOD_OPTIONS,
  HISTORY_PRESET_OPTIONS,
} from '../lib/orderHistory';
import {
  buildDraftFromExternalMenu,
  EXTERNAL_AI_MENU_JSON_EXAMPLES,
  EXTERNAL_AI_MENU_PROMPTS,
  validateExternalMenuJson
} from '../lib/externalMenuImport';
import {
  buildPublishableCategories,
  createEmptyItem,
  createManualMenuDraft,
  normalizeMenuDraft,
  validatePublishableMenuDraft,
} from '../lib/adminMenuDraft';
import { useSocketStatus } from '../lib/useSocketStatus';

const EXTERNAL_PROMPT_OPTIONS = [
  {
    id: 'single_image',
    label: 'Una imagen',
    description: 'Usalo cuando vas a mandar una sola foto del menú.'
  },
  {
    id: 'multi_image',
    label: 'Varias imágenes',
    description: 'Usalo cuando el menú está repartido en varias fotos.'
  }
];

const SOCKET_STATUS_CONFIG = {
  connected: {
    label: 'Realtime conectado',
    badge: 'Conectado',
    color: 'var(--success)',
    background: 'rgba(46, 204, 113, 0.12)'
  },
  reconnecting: {
    label: 'Reconectando tablero...',
    badge: 'Reconectando',
    color: 'var(--warning)',
    background: 'rgba(241, 196, 15, 0.12)'
  },
  disconnected: {
    label: 'Sin conexión con el backend',
    badge: 'Desconectado',
    color: 'var(--danger)',
    background: 'rgba(231, 76, 60, 0.12)'
  }
};

const ITEM_FLAG_LABELS = {
  price_estimated_from_ocr: 'Precio estimado desde OCR',
  low_confidence_name: 'Nombre dudoso',
  low_confidence_description: 'Descripción dudosa',
  inferred_category: 'Categoría inferida',
  manual_review_added: 'Agregado manualmente',
  price_missing: 'Precio pendiente',
  description_from_review: 'Descripción agregada desde revisión'
};

const CATEGORY_FLAG_LABELS = {
  heuristic_beverage_group: 'Agrupada como bebidas por heurística'
};

const OCR_VARIANT_LABELS = {
  original: 'Original',
  enhanced: 'Mejorada',
  'enhanced-threshold': 'Binarizada'
};

const TABLE_REQUEST_LABELS = {
  call_waiter: 'Llamar al mozo',
  request_bill: 'Pedir la cuenta',
};

const TABLE_REQUEST_TYPE_CONFIG = {
  call_waiter: {
    icon: Bell,
    className: 'is-waiter',
    helper: 'La mesa necesita asistencia del salón.'
  },
  request_bill: {
    icon: Receipt,
    className: 'is-bill',
    helper: 'La mesa pidió la cuenta.'
  }
};

const PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'other', label: 'Otro' },
];

const PAYMENT_METHOD_LABELS = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  other: 'Otro',
};

const REVIEW_REASON_LABELS = {
  service_note: 'Aclaración general del menú',
  low_confidence_description: 'Descripción dudosa',
  low_confidence_name: 'Nombre dudoso',
  price_estimated_from_ocr: 'Precio estimado desde OCR',
  inferred_category: 'Categoría inferida',
  orphan_description: 'Descripción suelta',
  unclassified_line: 'Línea sin clasificar',
  decorative_noise: 'Ruido decorativo',
  low_confidence_noise: 'Ruido de baja confianza',
  image_block: 'Bloque detectado como imagen',
  empty_after_cleanup: 'Vacía tras limpieza',
};

const PREPROCESSING_STEP_LABELS = {
  autocrop_whitespace: 'Autocrop',
  grayscale: 'Escala de grises',
  normalize: 'Normalización',
  contrast: 'Contraste',
  sharpen: 'Sharpen',
  binary_threshold_212: 'Binarización',
};

const TABLE_COLOR_CLASSES = [
  'is-table-0',
  'is-table-1',
  'is-table-2',
  'is-table-3',
  'is-table-4',
  'is-table-5',
];

function moveItem(array, index, direction) {
  const targetIndex = index + direction;

  if (targetIndex < 0 || targetIndex >= array.length) {
    return array;
  }

  const nextArray = [...array];
  const [item] = nextArray.splice(index, 1);
  nextArray.splice(targetIndex, 0, item);
  return nextArray;
}

function getItemFlagLabels(flags = []) {
  return flags.map((flag) => ITEM_FLAG_LABELS[flag] || flag);
}

function getCategoryFlagLabels(flags = []) {
  return flags.map((flag) => CATEGORY_FLAG_LABELS[flag] || flag);
}

function formatOcrVariantLabel(name) {
  return OCR_VARIANT_LABELS[name] || name || 'Original';
}

function formatStepLabel(step) {
  if (PREPROCESSING_STEP_LABELS[step]) {
    return PREPROCESSING_STEP_LABELS[step];
  }

  if (/^upscale_/.test(step)) {
    return `Escalado ${step.replace('upscale_', '').replace('x', 'x')}`;
  }

  if (/^downscale_/.test(step)) {
    return `Reducción ${step.replace('downscale_', '').replace('x', 'x')}`;
  }

  return step;
}

function getTableBadgeClass(tableId) {
  const parsedId = Number.parseInt(String(tableId ?? '0'), 10);
  const index = Number.isInteger(parsedId) ? Math.abs(parsedId) % TABLE_COLOR_CLASSES.length : 0;
  return TABLE_COLOR_CLASSES[index];
}

function formatOrderTime(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatOrderDateTime(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString([], {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDurationMinutes(start, end) {
  if (!start || !end) {
    return '';
  }

  const durationMs = new Date(end).getTime() - new Date(start).getTime();

  if (Number.isNaN(durationMs) || durationMs <= 0) {
    return '';
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
  return `${totalMinutes} min`;
}

function formatMenuMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatPaymentMethodLabel(value) {
  return PAYMENT_METHOD_LABELS[value] || 'Pago';
}

function sortTables(tables = []) {
  return [...tables].sort((left, right) => left.id - right.id);
}

function escapePrintableHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildPrintableTablesDocument({ restaurantName, tables }) {
  const cardsMarkup = tables
    .map((table) => {
      const title = table.label || `Mesa ${table.id}`;

      return `
        <article class="qr-card">
          <div class="qr-card-kicker">${escapePrintableHtml(restaurantName)}</div>
          <div class="qr-card-head">
            <h2>${escapePrintableHtml(title)}</h2>
            <span>Escaneá para ver el menú y pedir desde esta mesa.</span>
          </div>
          <div class="qr-card-body">
            <img src="${table.qr_image}" alt="QR ${escapePrintableHtml(title)}" />
          </div>
          <div class="qr-card-foot">
            <strong>${escapePrintableHtml(table.url)}</strong>
          </div>
        </article>
      `;
    })
    .join('');

  return `<!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <title>${escapePrintableHtml(restaurantName)} · QRs de mesas</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 28px;
          font-family: Inter, system-ui, sans-serif;
          color: #1d1a17;
          background: #f7f2ea;
        }
        .sheet-head {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: end;
          margin-bottom: 24px;
        }
        .sheet-head h1 {
          margin: 0 0 6px;
          font-size: 30px;
        }
        .sheet-head p {
          margin: 0;
          color: #6f665d;
        }
        .qr-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 18px;
        }
        .qr-card {
          break-inside: avoid;
          page-break-inside: avoid;
          border: 2px dashed rgba(78, 61, 39, 0.24);
          background: white;
          border-radius: 28px;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 18px;
          box-shadow: 0 12px 28px rgba(98, 76, 46, 0.08);
        }
        .qr-card-kicker {
          display: inline-flex;
          width: fit-content;
          padding: 6px 12px;
          border-radius: 999px;
          background: rgba(255, 94, 58, 0.12);
          color: #c24d2d;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .qr-card-head h2 {
          margin: 0 0 4px;
          font-size: 30px;
        }
        .qr-card-head span {
          color: #6f665d;
          font-size: 14px;
          line-height: 1.4;
        }
        .qr-card-body {
          padding: 18px;
          border-radius: 24px;
          border: 1px solid rgba(78, 61, 39, 0.12);
          background: #fffaf5;
          display: flex;
          justify-content: center;
        }
        .qr-card img {
          width: 100%;
          max-width: 300px;
          aspect-ratio: 1;
          align-self: center;
        }
        .qr-card-foot {
          padding-top: 4px;
          border-top: 1px solid rgba(78, 61, 39, 0.12);
        }
        .qr-card strong {
          display: block;
          text-align: center;
          font-size: 12px;
          word-break: break-all;
          color: #6f665d;
        }
        @media print {
          body { padding: 16px; background: white; }
          .qr-grid { gap: 12px; }
          .qr-card { box-shadow: none; }
        }
      </style>
    </head>
    <body>
      <header class="sheet-head">
        <div>
          <h1>${escapePrintableHtml(restaurantName)}</h1>
          <p>QRs de mesas listos para imprimir o exportar a PDF.</p>
        </div>
        <p>${tables.length} mesa(s)</p>
      </header>
      <section class="qr-grid">${cardsMarkup}</section>
    </body>
  </html>`;
}

function formatReviewReason(reason = '') {
  return String(reason)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => REVIEW_REASON_LABELS[token] || token)
    .join(' · ');
}

function reviewLineIdentity(line = {}) {
  return `${line.text || ''}::${line.reason || ''}::${line.confidence ?? ''}`;
}

function reviewCategoryDomId(categoryIndex) {
  return `review-category-${categoryIndex}`;
}

function reviewItemDomId(categoryIndex, itemIndex) {
  return `review-item-${categoryIndex}-${itemIndex}`;
}

function buildPendingReviewEntries(draft) {
  const suspiciousLines = Array.isArray(draft?.suspiciousLines) ? draft.suspiciousLines : [];
  const suspiciousIds = new Set(suspiciousLines.map(reviewLineIdentity));
  const discardedLines = (Array.isArray(draft?.discardedLines) ? draft.discardedLines : [])
    .filter((line) => !suspiciousIds.has(reviewLineIdentity(line)));

  return [
    ...suspiciousLines.map((line, index) => ({
      id: reviewLineIdentity(line),
      line,
      source: 'suspicious',
      index,
    })),
    ...discardedLines.map((line, index) => ({
      id: reviewLineIdentity(line),
      line,
      source: 'discarded',
      index,
    })),
  ];
}

function parsePriceFromReviewText(text = '') {
  const cleaned = String(text || '').trim();
  const tailMatch = cleaned.match(/(?:\$|s\/)?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$/i);

  if (!tailMatch) {
    return { name: cleaned, price: '' };
  }

  const numericValue = Number(tailMatch[1].replace(',', '.'));
  const name = cleaned.slice(0, tailMatch.index).trim();

  return {
    name: name || cleaned,
    price: Number.isFinite(numericValue) ? numericValue : '',
  };
}

function createItemFromReviewLine(line) {
  const parsed = parsePriceFromReviewText(line?.text || '');
  const flags = ['manual_review_added'];

  if (parsed.price === '') {
    flags.push('price_missing');
  }

  return {
    name: parsed.name,
    description: '',
    price: parsed.price,
    confidence: line?.confidence ?? null,
    flags,
  };
}

function createRecoveredCategory() {
  return {
    name: 'Rescatados del OCR',
    confidence: null,
    reviewCount: 0,
    flags: [],
    items: [],
  };
}

function getFallbackReviewTarget(categories = []) {
  if (!categories.length) {
    return { categoryIndex: '', itemIndex: '' };
  }

  const lastCategoryIndex = categories.length - 1;
  const lastCategoryItems = categories[lastCategoryIndex]?.items || [];

  return {
    categoryIndex: String(lastCategoryIndex),
    itemIndex: lastCategoryItems.length > 0 ? String(lastCategoryItems.length - 1) : '',
  };
}

function resolveReviewTarget(target, categories = []) {
  const fallback = getFallbackReviewTarget(categories);
  const parsedCategoryIndex = Number.parseInt(target?.categoryIndex ?? '', 10);
  const hasValidCategory = Number.isInteger(parsedCategoryIndex)
    && parsedCategoryIndex >= 0
    && parsedCategoryIndex < categories.length;

  if (!hasValidCategory) {
    return fallback;
  }

  const items = categories[parsedCategoryIndex]?.items || [];
  const parsedItemIndex = Number.parseInt(target?.itemIndex ?? '', 10);
  const hasValidItem = Number.isInteger(parsedItemIndex)
    && parsedItemIndex >= 0
    && parsedItemIndex < items.length;

  return {
    categoryIndex: String(parsedCategoryIndex),
    itemIndex: hasValidItem ? String(parsedItemIndex) : (items.length > 0 ? String(items.length - 1) : ''),
  };
}

function isDescriptionLikeLine(line) {
  return /description|service_note|orphan_description/.test(String(line?.reason || ''));
}

function findLastEmptyDescriptionIndex(items = []) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!String(items[index]?.description || '').trim()) {
      return index;
    }
  }

  return -1;
}

function getProbableItemIndex(line, items = [], preferredTarget = null, categoryIndex = '') {
  if (!items.length) {
    return '';
  }

  const preferredItemIndex = Number.parseInt(preferredTarget?.itemIndex ?? '', 10);
  if (
    String(preferredTarget?.categoryIndex ?? '') === String(categoryIndex)
    && Number.isInteger(preferredItemIndex)
    && preferredItemIndex >= 0
    && preferredItemIndex < items.length
  ) {
    return String(preferredItemIndex);
  }

  if (items.length === 1) {
    return '0';
  }

  if (isDescriptionLikeLine(line)) {
    const emptyDescriptionIndexes = items
      .map((item, index) => (!String(item.description || '').trim() ? index : null))
      .filter((index) => index !== null);

    if (emptyDescriptionIndexes.length === 1) {
      return String(emptyDescriptionIndexes[0]);
    }

    const lastEmptyDescriptionIndex = findLastEmptyDescriptionIndex(items);
    if (lastEmptyDescriptionIndex !== -1) {
      return String(lastEmptyDescriptionIndex);
    }
  }

  return '';
}

function getPreferredReviewTarget(line, categories = [], preferredTarget = null) {
  if (!categories.length) {
    return { categoryIndex: '', itemIndex: '' };
  }

  const preferredCategoryIndex = Number.parseInt(preferredTarget?.categoryIndex ?? '', 10);
  const hasValidPreferredCategory = Number.isInteger(preferredCategoryIndex)
    && preferredCategoryIndex >= 0
    && preferredCategoryIndex < categories.length;

  const categoryIndex = hasValidPreferredCategory
    ? String(preferredCategoryIndex)
    : getFallbackReviewTarget(categories).categoryIndex;

  const items = categories[Number.parseInt(categoryIndex, 10)]?.items || [];

  return {
    categoryIndex,
    itemIndex: getProbableItemIndex(
      line,
      items,
      hasValidPreferredCategory ? preferredTarget : null,
      categoryIndex
    ),
  };
}

function upsertTableRequest(list, nextRequest) {
  const filteredList = list.filter((request) => request.id !== nextRequest.id);
  return [nextRequest, ...filteredList].sort((left, right) => {
    const leftPending = left.status === 'pending' ? 0 : 1;
    const rightPending = right.status === 'pending' ? 0 : 1;

    if (leftPending !== rightPending) {
      return leftPending - rightPending;
    }

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

export default function AdminPanel({ socket, adminToken, venueSettings, onVenueSettingsSaved, onLogout, theme, onToggleTheme }) {
  const [orders, setOrders] = useState([]);
  const [ordersStatus, setOrdersStatus] = useState('loading');
  const [ordersError, setOrdersError] = useState('');
  const [ordersActionError, setOrdersActionError] = useState('');
  const [ordersReloadKey, setOrdersReloadKey] = useState(0);
  const [tableRequests, setTableRequests] = useState([]);
  const [tableRequestsStatus, setTableRequestsStatus] = useState('loading');
  const [tableRequestsError, setTableRequestsError] = useState('');
  const [tableRequestsActionError, setTableRequestsActionError] = useState('');
  const [resolvingRequestId, setResolvingRequestId] = useState(null);
  const [payingTableId, setPayingTableId] = useState(null);
  const [paymentMethodDrafts, setPaymentMethodDrafts] = useState({});
  const [showResolvedTableRequests, setShowResolvedTableRequests] = useState(false);
  const [showDeliveredOrders, setShowDeliveredOrders] = useState(false);
  const [historyFiltersDraft, setHistoryFiltersDraft] = useState(() => ({ ...DEFAULT_HISTORY_FILTERS }));
  const [historyFilters, setHistoryFilters] = useState(() => ({ ...DEFAULT_HISTORY_FILTERS }));
  const [historyOrders, setHistoryOrders] = useState([]);
  const [historyOrdersStatus, setHistoryOrdersStatus] = useState('loading');
  const [historyOrdersError, setHistoryOrdersError] = useState('');
  const [historySummary, setHistorySummary] = useState(null);
  const [historySummaryStatus, setHistorySummaryStatus] = useState('loading');
  const [historySummaryError, setHistorySummaryError] = useState('');
  const [historyExpandedOrderId, setHistoryExpandedOrderId] = useState(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [tables, setTables] = useState([]);
  const [tablesStatus, setTablesStatus] = useState('loading');
  const [tablesError, setTablesError] = useState('');
  const [tablesActionError, setTablesActionError] = useState('');
  const [tablesActionErrorTitle, setTablesActionErrorTitle] = useState('No pudimos actualizar las mesas.');
  const [tablesActionSuccess, setTablesActionSuccess] = useState('');
  const [tablesActionSuccessTitle, setTablesActionSuccessTitle] = useState('Mesa lista.');
  const [showAddTableModal, setShowAddTableModal] = useState(false);
  const [newTableId, setNewTableId] = useState('');
  const [isCreatingTable, setIsCreatingTable] = useState(false);
  const [deletingTableId, setDeletingTableId] = useState(null);
  const [activeTab, setActiveTab] = useState('kanban');
  const [settingsForm, setSettingsForm] = useState(() => normalizeVenueSettings(venueSettings));
  const [settingsErrors, setSettingsErrors] = useState({});
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [settingsFeedbackType, setSettingsFeedbackType] = useState('success');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  
  // Menu Import State
  const [file, setFile] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [parsedMenu, setParsedMenu] = useState(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isClearingMenu, setIsClearingMenu] = useState(false);
  const [menuActionError, setMenuActionError] = useState('');
  const [menuActionSuccess, setMenuActionSuccess] = useState('');
  const [activeMenuInfo, setActiveMenuInfo] = useState(null);
  const [activeMenuCategories, setActiveMenuCategories] = useState([]);
  const [activeMenuCatalogStatus, setActiveMenuCatalogStatus] = useState('loading');
  const [activeMenuCatalogError, setActiveMenuCatalogError] = useState('');
  const [togglingMenuItemId, setTogglingMenuItemId] = useState(null);
  const [importSource, setImportSource] = useState('image');
  const [externalMenuJson, setExternalMenuJson] = useState('');
  const [validatedExternalMenu, setValidatedExternalMenu] = useState(null);
  const [externalMenuError, setExternalMenuError] = useState('');
  const [externalMenuSuccess, setExternalMenuSuccess] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const [externalPromptVariant, setExternalPromptVariant] = useState('single_image');
  const [showClearMenuConfirm, setShowClearMenuConfirm] = useState(false);
  const [previewMode, setPreviewMode] = useState('original');
  const [reviewLineTargets, setReviewLineTargets] = useState({});
  const [lastReviewTarget, setLastReviewTarget] = useState(null);
  const [highlightedReviewTarget, setHighlightedReviewTarget] = useState(null);
  const [activeReviewLineId, setActiveReviewLineId] = useState('');
  const [reviewStats, setReviewStats] = useState({ rescued: 0, ignored: 0 });
  const reviewLineRefs = useRef(new Map());
  const importStartRef = useRef(null);
  const socketStatus = useSocketStatus(socket);
  const selectedPrompt =
    EXTERNAL_AI_MENU_PROMPTS[externalPromptVariant] || EXTERNAL_AI_MENU_PROMPTS.single_image;
  const selectedPromptLabel =
    EXTERNAL_PROMPT_OPTIONS.find((option) => option.id === externalPromptVariant)?.label ||
    'Una imagen';
  const normalizedVenueSettings = normalizeVenueSettings(venueSettings);
  const adminRestaurantName = normalizedVenueSettings.restaurant_name || RESTAURANT_NAME;
  const adminSubtitle = normalizedVenueSettings.restaurant_subtitle || 'Pedidos, solicitudes y menú en un mismo tablero.';

  useEffect(() => {
    setSettingsForm(normalizeVenueSettings(venueSettings));
    setSettingsErrors({});
  }, [venueSettings]);

  const refreshTables = async ({ showLoader = true } = {}) => {
    if (showLoader) {
      setTablesStatus('loading');
    }
    setTablesError('');

    try {
      const data = await apiRequest('/api/admin/tables', { token: adminToken });
      const nextTables = sortTables(Array.isArray(data) ? data : []);
      setTables(nextTables);
      setTablesStatus(nextTables.length > 0 ? 'ready' : 'empty');
      return nextTables;
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return [];
      }

      setTablesStatus('error');
      setTablesError(error.message);
      return [];
    }
  };

  const refreshActiveMenuInfo = async () => {
    try {
      const menu = await apiRequest('/api/menu/active', { token: adminToken });
      setActiveMenuInfo(menu || null);
      return menu || null;
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return null;
      }

      throw error;
    }
  };

  const refreshActiveMenuCatalog = async () => {
    try {
      const menu = await apiRequest('/api/menu');
      const nextCategories = Array.isArray(menu) ? menu : [];
      setActiveMenuCategories(nextCategories);
      setActiveMenuCatalogStatus(nextCategories.length > 0 ? 'ready' : 'empty');
      setActiveMenuCatalogError('');
      return nextCategories;
    } catch (error) {
      setActiveMenuCatalogStatus('error');
      setActiveMenuCatalogError(error.message);
      throw error;
    }
  };

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl('');
      return undefined;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    setFilePreviewUrl(nextPreviewUrl);

    return () => {
      URL.revokeObjectURL(nextPreviewUrl);
    };
  }, [file]);

  useEffect(() => {
    if (!parsedMenu) {
      setPreviewMode('original');
      setReviewLineTargets({});
      setLastReviewTarget(null);
      setHighlightedReviewTarget(null);
      setActiveReviewLineId('');
      setReviewStats({ rescued: 0, ignored: 0 });
      return;
    }

    setPreviewMode(parsedMenu.diagnostics?.ocr_variant || parsedMenu.previewImages?.[0]?.name || 'original');
  }, [parsedMenu]);

  useEffect(() => {
    if (!activeReviewLineId) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      reviewLineRefs.current.get(activeReviewLineId)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeReviewLineId, parsedMenu]);

  useEffect(() => {
    if (!highlightedReviewTarget) {
      return undefined;
    }

    const targetId = highlightedReviewTarget.itemIndex === ''
      ? reviewCategoryDomId(highlightedReviewTarget.categoryIndex)
      : reviewItemDomId(highlightedReviewTarget.categoryIndex, highlightedReviewTarget.itemIndex);

    const frameId = window.requestAnimationFrame(() => {
      window.document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const timeoutId = window.setTimeout(() => {
      setHighlightedReviewTarget(null);
    }, 1800);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [highlightedReviewTarget]);

  useEffect(() => {
    let isMounted = true;

    const loadActiveMenuState = async () => {
      try {
        const [menu, categories] = await Promise.all([
          apiRequest('/api/menu/active', { token: adminToken }),
          apiRequest('/api/menu'),
        ]);

        if (!isMounted) {
          return;
        }

        setActiveMenuInfo(menu || null);
        const nextCategories = Array.isArray(categories) ? categories : [];
        setActiveMenuCategories(nextCategories);
        setActiveMenuCatalogStatus(nextCategories.length > 0 ? 'ready' : 'empty');
        setActiveMenuCatalogError('');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setMenuActionError(error.message);
      }
    };

    loadActiveMenuState();

    return () => {
      isMounted = false;
    };
  }, [adminToken, onLogout]);

  useEffect(() => {
    let isMounted = true;

    const loadOrders = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setOrdersStatus('loading');
      }
      setOrdersError('');

      try {
        const data = await apiRequest('/api/admin/orders/open', { token: adminToken });

        if (!isMounted) {
          return;
        }

        const nextOrders = Array.isArray(data) ? data : [];
        setOrders(nextOrders);
        setOrdersStatus(nextOrders.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setOrdersStatus('error');
        setOrdersError(error.message);
      }
    };

    const loadTableRequests = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setTableRequestsStatus('loading');
      }
      setTableRequestsError('');

      try {
        const data = await apiRequest('/api/table-requests', { token: adminToken });

        if (!isMounted) {
          return;
        }

        const nextRequests = Array.isArray(data) ? data : [];
        setTableRequests(nextRequests);
        setTableRequestsStatus(nextRequests.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setTableRequestsStatus('error');
        setTableRequestsError(error.message);
      }
    };

    const loadTables = async ({ showLoader = true } = {}) => {
      if (showLoader) {
        setTablesStatus('loading');
      }
      setTablesError('');

      try {
        const data = await apiRequest('/api/admin/tables', { token: adminToken });

        if (!isMounted) {
          return;
        }

        const nextTables = sortTables(Array.isArray(data) ? data : []);
        setTables(nextTables);
        setTablesStatus(nextTables.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setTablesStatus('error');
        setTablesError(error.message);
      }
    };

    const loadActiveMenuInfo = async () => {
      try {
        const menu = await apiRequest('/api/menu/active', { token: adminToken });

        if (!isMounted) {
          return;
        }

        setActiveMenuInfo(menu || null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setMenuActionError(error.message);
      }
    };

    const loadActiveMenuCatalog = async () => {
      setActiveMenuCatalogStatus('loading');
      setActiveMenuCatalogError('');

      try {
        const data = await apiRequest('/api/menu');

        if (!isMounted) {
          return;
        }

        const nextCategories = Array.isArray(data) ? data : [];
        setActiveMenuCategories(nextCategories);
        setActiveMenuCatalogStatus(nextCategories.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setActiveMenuCatalogStatus('error');
        setActiveMenuCatalogError(error.message);
      }
    };

    const joinAdminRoom = () => {
      socket.emit('join_admin', { token: adminToken });
    };

    const handleAuthError = ({ status }) => {
      if (status === 401 || status === 403) {
        onLogout();
      }
    };

    const handleNewOrder = (order) => {
      setOrders(prev => [order, ...prev.filter(existingOrder => existingOrder.id !== order.id)]);
      setOrdersStatus('ready');
      setOrdersError('');

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('Nuevo Pedido - Mesa ' + order.table_id);
      }
    };

    const handleOrderUpdated = (order) => {
      setOrders((previous) => {
        const nextOrders = order?.closed_at
          ? previous.filter((existingOrder) => existingOrder.id !== order.id)
          : [order, ...previous.filter((existingOrder) => existingOrder.id !== order.id)];
        setOrdersStatus(nextOrders.length > 0 ? 'ready' : 'empty');
        return nextOrders;
      });
      setOrdersActionError('');

      if (order?.closed_at) {
        setHistoryReloadKey((current) => current + 1);
      }
    };

    const handleTableRequestCreated = (request) => {
      setTableRequests((previous) => upsertTableRequest(previous, request));
      setTableRequestsStatus('ready');
      setTableRequestsError('');

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(`${TABLE_REQUEST_LABELS[request.type] || 'Solicitud de mesa'} - Mesa ${request.table_id}`);
      }
    };

    const handleTableRequestUpdated = (request) => {
      setTableRequests((previous) => upsertTableRequest(previous, request));
      setTableRequestsStatus('ready');
      setTableRequestsError('');
      setTableRequestsActionError('');
    };

    const handleOrderError = ({ error }) => {
      setOrdersActionError(error || 'No pudimos actualizar el pedido.');
    };

    const handleSocketConnect = () => {
      joinAdminRoom();
      loadOrders({ showLoader: false });
      loadTableRequests({ showLoader: false });
      loadTables({ showLoader: false });
      loadActiveMenuInfo();
      loadActiveMenuCatalog();
    };

    const handleMenuUpdated = () => {
      loadActiveMenuInfo();
      loadActiveMenuCatalog();
    };

    joinAdminRoom();
    loadOrders();
    loadTableRequests();
    loadTables();
    loadActiveMenuInfo();
    loadActiveMenuCatalog();

    socket.on('connect', handleSocketConnect);
    socket.on('new_order', handleNewOrder);
    socket.on('order_updated', handleOrderUpdated);
    socket.on('menu_updated', handleMenuUpdated);
    socket.on('table_request_created', handleTableRequestCreated);
    socket.on('table_request_updated', handleTableRequestUpdated);
    socket.on('order_error', handleOrderError);
    socket.on('auth_error', handleAuthError);

    return () => {
      isMounted = false;
      socket.off('connect', handleSocketConnect);
      socket.off('new_order', handleNewOrder);
      socket.off('order_updated', handleOrderUpdated);
      socket.off('menu_updated', handleMenuUpdated);
      socket.off('table_request_created', handleTableRequestCreated);
      socket.off('table_request_updated', handleTableRequestUpdated);
      socket.off('order_error', handleOrderError);
      socket.off('auth_error', handleAuthError);
    };
  }, [adminToken, onLogout, ordersReloadKey, socket]);

  useEffect(() => {
    if (activeTab !== 'history') {
      return undefined;
    }

    let isMounted = true;
    const queryString = buildHistoryQuery(historyFilters);

    const loadHistoryOrders = async () => {
      setHistoryOrdersStatus('loading');
      setHistoryOrdersError('');

      try {
        const data = await apiRequest(`/api/admin/orders/history${queryString}`, { token: adminToken });

        if (!isMounted) {
          return;
        }

        const nextOrders = Array.isArray(data?.orders) ? data.orders : [];
        setHistoryOrders(nextOrders);
        setHistoryOrdersStatus(nextOrders.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setHistoryOrdersStatus('error');
        setHistoryOrdersError(error.message);
      }
    };

    const loadHistorySummary = async () => {
      setHistorySummaryStatus('loading');
      setHistorySummaryError('');

      try {
        const data = await apiRequest(`/api/admin/orders/history/summary${queryString}`, { token: adminToken });

        if (!isMounted) {
          return;
        }

        setHistorySummary(data || null);
        setHistorySummaryStatus('ready');
      } catch (error) {
        if (!isMounted) {
          return;
        }

        if (isAuthError(error)) {
          onLogout();
          return;
        }

        setHistorySummaryStatus('error');
        setHistorySummaryError(error.message);
      }
    };

    loadHistoryOrders();
    loadHistorySummary();

    return () => {
      isMounted = false;
    };
  }, [activeTab, adminToken, historyFilters, historyReloadKey, onLogout]);

  const updateStatus = (orderId, newStatus) => {
    setOrdersActionError('');
    socket.emit('update_order_status', { order_id: orderId, status: newStatus, token: adminToken });
  };

  const updatePaymentMethodDraft = (orderId, paymentMethod) => {
    setPaymentMethodDrafts((current) => ({
      ...current,
      [orderId]: paymentMethod,
    }));
  };

  const recordPayment = async (order) => {
    const selectedPaymentMethod = paymentMethodDrafts[order.id] || 'cash';

    setPayingTableId(order.table_id);
    setOrdersActionError('');

    try {
      const closedOrder = await apiRequest(`/api/tables/${order.table_id}/payment`, {
        method: 'POST',
        token: adminToken,
        body: {
          payment_method: selectedPaymentMethod,
        },
      });

      setOrders((previous) => {
        const nextOrders = previous.filter((entry) => entry.id !== closedOrder.id);
        setOrdersStatus(nextOrders.length > 0 ? 'ready' : 'empty');
        return nextOrders;
      });
      setHistoryReloadKey((current) => current + 1);
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setOrdersActionError(error.message);
    } finally {
      setPayingTableId(null);
    }
  };

  const resolvePendingTableRequest = async (requestId) => {
    setResolvingRequestId(requestId);
    setTableRequestsActionError('');

    try {
      const resolvedRequest = await apiRequest(`/api/table-requests/${requestId}/resolve`, {
        method: 'POST',
        token: adminToken,
      });

      setTableRequests((previous) => upsertTableRequest(previous, resolvedRequest));
      setTableRequestsStatus('ready');
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setTableRequestsActionError(error.message);
    } finally {
      setResolvingRequestId(null);
    }
  };

  const handleFileUpload = async (e) => {
    e.preventDefault();
    if (!file) return;

    setIsProcessing(true);
    setMenuActionError('');
    setMenuActionSuccess('');
    const formData = new FormData();
    formData.append('menuImage', file);

    try {
      const data = await apiRequest('/api/menu/upload', {
        method: 'POST',
        body: formData,
        token: adminToken
      });

      const nextParsedMenu = Array.isArray(data?.categories)
        ? data.categories
        : Array.isArray(data)
          ? data
          : [];

      if (nextParsedMenu.length === 0) {
        setParsedMenu(null);
        setMenuActionError('No pudimos extraer un menú utilizable de la imagen. Probá con una foto más nítida.');
        return;
      }

      const normalizedDraft = normalizeMenuDraft(data, 'image');
      const pendingEntries = buildPendingReviewEntries(normalizedDraft);
      setParsedMenu(normalizedDraft);
      setImportSource('image');
      setReviewStats({ rescued: 0, ignored: 0 });
      setActiveReviewLineId(pendingEntries[0]?.id || '');
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setMenuActionError(error.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopyExternalPrompt = async () => {
    try {
      await navigator.clipboard.writeText(selectedPrompt);
      setPromptCopied(true);
      setExternalMenuSuccess(
        `Prompt de "${selectedPromptLabel}" copiado. Ahora podés usarlo con otra IA y después pegar el JSON acá.`
      );
      window.setTimeout(() => setPromptCopied(false), 1800);
    } catch {
      setExternalMenuError('No pudimos copiar el prompt. Copialo manualmente desde el panel.');
    }
  };

  const handlePasteExternalMenuExample = (exampleType) => {
    const nextExample =
      exampleType === 'invalid'
        ? EXTERNAL_AI_MENU_JSON_EXAMPLES.invalid
        : EXTERNAL_AI_MENU_JSON_EXAMPLES.valid;

    setExternalMenuJson(nextExample);
    setValidatedExternalMenu(null);
    setExternalMenuError('');
    setExternalMenuSuccess(
      exampleType === 'invalid'
        ? 'Cargamos un ejemplo inválido para probar la validación.'
        : 'Cargamos un ejemplo válido para probar el flujo completo.'
    );
  };

  const handleValidateExternalMenu = () => {
    setExternalMenuError('');
    setExternalMenuSuccess('');

    try {
      const validatedMenu = validateExternalMenuJson(externalMenuJson);
      setValidatedExternalMenu(validatedMenu);
      setExternalMenuSuccess(
        `JSON válido: ${validatedMenu.summary.categoryCount} categoría(s), ${validatedMenu.summary.itemCount} producto(s) y ${validatedMenu.summary.pricesPendingCount} precio(s) pendientes.`
      );
    } catch (error) {
      setValidatedExternalMenu(null);
      setExternalMenuError(error.message);
    }
  };

  const handleConvertExternalMenuToDraft = () => {
    setExternalMenuError('');
    setExternalMenuSuccess('');

    try {
      const validatedMenu = validatedExternalMenu || validateExternalMenuJson(externalMenuJson);
      const nextDraft = normalizeMenuDraft(buildDraftFromExternalMenu(validatedMenu), 'external_ai');
      setParsedMenu(nextDraft);
      setMenuActionSuccess('JSON convertido a borrador. Revisalo antes de publicarlo.');
      setValidatedExternalMenu(validatedMenu);
      setImportSource('external_ai');
    } catch (error) {
      setValidatedExternalMenu(null);
      setExternalMenuError(error.message);
    }
  };

  const publishMenu = async () => {
    if (!parsedMenu || parsedMenu.categories.length === 0) {
      return;
    }

    setIsPublishing(true);
    setMenuActionError('');
    setMenuActionSuccess('');

    try {
      const publishValidationError = validatePublishableMenuDraft(parsedMenu);

      if (publishValidationError) {
        setMenuActionError(publishValidationError);
        return;
      }

      const publishableCategories = buildPublishableCategories(parsedMenu.categories);

      if (publishableCategories.length === 0) {
        setMenuActionError('El borrador no tiene categorías con platos válidos para publicar.');
        return;
      }

      await apiRequest('/api/menu/publish', {
        method: 'POST',
        body: {
          name: parsedMenu.name,
          categories: publishableCategories,
        },
        token: adminToken
      });

      setMenuActionSuccess('Menú publicado exitosamente.');
      setParsedMenu(null);
      setFile(null);
      setActiveMenuInfo(await refreshActiveMenuInfo());
      await refreshActiveMenuCatalog();
      setActiveTab('kanban');
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setMenuActionError(error.message);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleCreateManualDraft = () => {
    setMenuActionError('');
    setMenuActionSuccess('');
    setParsedMenu(createManualMenuDraft());
    setImportSource('manual');
  };

  const focusImportFlow = () => {
    setActiveTab('menu_import');
    setImportSource('image');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        importStartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  };

  const openVenueSettings = () => {
    setActiveTab('venue_settings');
    setSettingsFeedback('');
    setSettingsFeedbackType('success');
  };

  const openHistory = () => {
    setActiveTab('history');
  };

  const updateHistoryDraftField = (field, value) => {
    setHistoryFiltersDraft((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const applyHistoryPreset = (preset) => {
    const nextFilters = {
      ...DEFAULT_HISTORY_FILTERS,
      preset,
    };

    setHistoryFiltersDraft(nextFilters);
    setHistoryFilters(nextFilters);
    setHistoryExpandedOrderId(null);
  };

  const applyHistoryFilters = () => {
    setHistoryFilters({
      ...historyFiltersDraft,
      offset: 0,
    });
    setHistoryExpandedOrderId(null);
  };

  const clearHistoryFilters = () => {
    setHistoryFiltersDraft({ ...DEFAULT_HISTORY_FILTERS });
    setHistoryFilters({ ...DEFAULT_HISTORY_FILTERS });
    setHistoryExpandedOrderId(null);
  };

  const openAddTableModal = () => {
    const nextTableId = (tables[tables.length - 1]?.id || 0) + 1;
    setNewTableId(String(nextTableId));
    setTablesActionError('');
    setTablesActionErrorTitle('No pudimos actualizar las mesas.');
    setTablesActionSuccess('');
    setTablesActionSuccessTitle('Mesa lista.');
    setShowAddTableModal(true);
    refreshTables({ showLoader: tablesStatus === 'loading' || tablesStatus === 'empty' });
  };

  const printTableCards = (selectedTables) => {
    if (!Array.isArray(selectedTables) || selectedTables.length === 0) {
      return;
    }

    setTablesActionError('');

    const printFrame = document.createElement('iframe');
    printFrame.setAttribute('aria-hidden', 'true');
    printFrame.style.position = 'fixed';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    printFrame.style.opacity = '0';
    printFrame.style.pointerEvents = 'none';
    document.body.appendChild(printFrame);

    const frameWindow = printFrame.contentWindow;
    const frameDocument = printFrame.contentDocument;

    if (!frameWindow || !frameDocument) {
      printFrame.remove();
      return;
    }

    frameDocument.open();
    frameDocument.write(
      buildPrintableTablesDocument({
        restaurantName: adminRestaurantName,
        tables: selectedTables
      })
    );
    frameDocument.close();

    const cleanup = () => {
      window.setTimeout(() => {
        printFrame.remove();
      }, 120);
    };

    frameWindow.addEventListener('afterprint', cleanup, { once: true });

    window.setTimeout(() => {
      frameWindow.focus();
      frameWindow.print();
      window.setTimeout(cleanup, 1200);
    }, 180);
  };

  const handleCreateTable = async (event) => {
    event.preventDefault();
    setIsCreatingTable(true);
    setTablesActionError('');
    setTablesActionErrorTitle('No pudimos actualizar las mesas.');
    setTablesActionSuccess('');
    setTablesActionSuccessTitle('Mesa lista.');

    try {
      const createdTable = await apiRequest('/api/admin/tables', {
        method: 'POST',
        token: adminToken,
        body: {
          table_id: newTableId
        }
      });

      setTables((previous) => {
        const nextTables = sortTables([
          ...previous.filter((table) => table.id !== createdTable.id),
          createdTable
        ]);
        return nextTables;
      });
      setTablesStatus('ready');
      setNewTableId(String(createdTable.id + 1));
      setTablesActionSuccessTitle('Mesa lista.');
      setTablesActionSuccess(`Mesa ${createdTable.id} creada. El QR ya está listo para imprimir.`);
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setTablesActionErrorTitle('No pudimos actualizar las mesas.');
      setTablesActionError(error.message);
    } finally {
      setIsCreatingTable(false);
    }
  };

  const handleDeleteTable = async (tableId) => {
    if (!window.confirm(`¿Eliminar la mesa ${tableId}?`)) {
      return;
    }

    setDeletingTableId(tableId);
    setTablesActionError('');
    setTablesActionErrorTitle('No pudimos actualizar las mesas.');
    setTablesActionSuccess('');
    setTablesActionSuccessTitle('Mesa lista.');

    try {
      await apiRequest(`/api/admin/tables/${tableId}`, {
        method: 'DELETE',
        token: adminToken,
      });

      setTables((previous) => {
        const nextTables = previous.filter((table) => table.id !== tableId);
        setTablesStatus(nextTables.length > 0 ? 'ready' : 'empty');
        return nextTables;
      });
      setTablesActionSuccessTitle('Mesa eliminada.');
      setTablesActionSuccess(`Mesa ${tableId} eliminada.`);
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setTablesActionErrorTitle('No pudimos actualizar las mesas.');
      setTablesActionError(error.message);
    } finally {
      setDeletingTableId(null);
    }
  };

  const clearActiveMenu = async () => {
    if (!activeMenuInfo) {
      setMenuActionError('No hay un menú publicado para quitar.');
      return;
    }

    setIsClearingMenu(true);
    setMenuActionError('');
    setMenuActionSuccess('');

    try {
      await apiRequest('/api/menu/active', {
        method: 'DELETE',
        token: adminToken,
      });

      setActiveMenuInfo(await refreshActiveMenuInfo());
      await refreshActiveMenuCatalog();
      setMenuActionSuccess('El menú publicado se quitó correctamente.');
      setParsedMenu(null);
      setFile(null);
      setShowClearMenuConfirm(false);
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setActiveMenuInfo(await refreshActiveMenuInfo());
      await refreshActiveMenuCatalog();
      setMenuActionError(
        error?.status === 404
          ? 'No hay un menú publicado para quitar.'
          : 'No se pudo quitar el menú publicado. Intentá de nuevo.'
      );
    } finally {
      setIsClearingMenu(false);
    }
  };

  const toggleMenuItemAvailability = async (itemId, nextAvailability) => {
    setTogglingMenuItemId(itemId);
    setMenuActionError('');
    setMenuActionSuccess('');

    try {
      const updatedItem = await apiRequest(`/api/admin/menu-items/${itemId}/availability`, {
        method: 'PATCH',
        token: adminToken,
        body: {
          is_available: nextAvailability,
        },
      });

      setActiveMenuCategories((previous) => previous.map((category) => ({
        ...category,
        items: (category.items || []).map((item) => (
          item.id === updatedItem.id ? { ...item, is_available: updatedItem.is_available } : item
        )),
      })));
      setMenuActionSuccess(
        updatedItem.is_available
          ? `"${updatedItem.name}" volvió a quedar disponible.`
          : `"${updatedItem.name}" quedó marcado como no disponible.`
      );
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      setMenuActionError(error.message);
    } finally {
      setTogglingMenuItemId(null);
    }
  };

  const updateSettingsField = (field, value) => {
    setSettingsForm((current) => ({
      ...current,
      [field]: value,
    }));
    setSettingsErrors((current) => {
      if (!current[field] && !current.contact) {
        return current;
      }

      const nextErrors = { ...current };
      delete nextErrors[field];
      if (field === 'contact_label' || field === 'contact_url') {
        delete nextErrors.contact;
      }
      return nextErrors;
    });
    setSettingsFeedback('');
  };

  const saveVenueSettings = async () => {
    const nextErrors = validateVenueSettingsForm(settingsForm);
    setSettingsErrors(nextErrors);
    setSettingsFeedback('');

    if (Object.keys(nextErrors).length > 0) {
      setSettingsFeedbackType('error');
      setSettingsFeedback('Revisá los campos marcados antes de guardar.');
      return;
    }

    setIsSavingSettings(true);

    try {
      const nextSettings = await apiRequest('/api/admin/venue-settings', {
        method: 'PUT',
        token: adminToken,
        body: prepareVenueSettingsPayload(settingsForm),
      });
      const normalized = normalizeVenueSettings(nextSettings);
      setSettingsForm(normalized);
      setSettingsErrors({});
      setSettingsFeedbackType('success');
      setSettingsFeedback('Configuración guardada.');
      onVenueSettingsSaved?.(normalized);
    } catch (error) {
      if (isAuthError(error)) {
        onLogout();
        return;
      }

      const fieldErrors = error?.details?.fields;
      if (fieldErrors && typeof fieldErrors === 'object') {
        setSettingsErrors(fieldErrors);
      }
      setSettingsFeedbackType('error');
      setSettingsFeedback(error.message);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const updateParsedItem = (catIdx, itemIdx, field, value) => {
      setParsedMenu((currentDraft) => {
        if (!currentDraft) {
          return currentDraft;
        }

        const nextCategories = [...currentDraft.categories];
        nextCategories[catIdx] = {
          ...nextCategories[catIdx],
          items: nextCategories[catIdx].items.map((item, index) => (
            index === itemIdx ? { ...item, [field]: value } : item
          )),
        };

        return {
          ...currentDraft,
          categories: nextCategories,
        };
      });
  };
  
  const updateParsedCat = (catIdx, value) => {
      setParsedMenu((currentDraft) => {
        if (!currentDraft) {
          return currentDraft;
        }

        const nextCategories = [...currentDraft.categories];
        nextCategories[catIdx] = {
          ...nextCategories[catIdx],
          name: value,
        };

        return {
          ...currentDraft,
          categories: nextCategories,
        };
      });
  };

  const updateDraftName = (value) => {
    setParsedMenu((currentDraft) => currentDraft ? { ...currentDraft, name: value } : currentDraft);
  };

  const removeParsedCategory = (catIdx) => {
    setParsedMenu((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      return {
        ...currentDraft,
        categories: currentDraft.categories.filter((_, index) => index !== catIdx),
      };
    });
  };

  const moveParsedCategory = (catIdx, direction) => {
    setParsedMenu((currentDraft) => currentDraft ? {
      ...currentDraft,
      categories: moveItem(currentDraft.categories, catIdx, direction),
    } : currentDraft);
  };

  const addParsedCategory = () => {
    setParsedMenu((currentDraft) => currentDraft ? {
      ...currentDraft,
      categories: [
        ...currentDraft.categories,
        {
          name: 'Nueva categoría',
          confidence: null,
          reviewCount: 0,
          flags: [],
          items: [createEmptyItem()],
        },
      ],
    } : currentDraft);
  };

  const addParsedItem = (catIdx) => {
    setParsedMenu((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      const nextCategories = [...currentDraft.categories];
      nextCategories[catIdx] = {
        ...nextCategories[catIdx],
        items: [...nextCategories[catIdx].items, createEmptyItem()],
      };

      return {
        ...currentDraft,
        categories: nextCategories,
      };
    });
  };

  const moveParsedItem = (catIdx, itemIdx, direction) => {
    setParsedMenu((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      const nextCategories = [...currentDraft.categories];
      nextCategories[catIdx] = {
        ...nextCategories[catIdx],
        items: moveItem(nextCategories[catIdx].items, itemIdx, direction),
      };

      return {
        ...currentDraft,
        categories: nextCategories,
      };
    });
  };

  const removeParsedItem = (catIdx, itemIdx) => {
    setParsedMenu((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      const nextCategories = [...currentDraft.categories];
      nextCategories[catIdx] = {
        ...nextCategories[catIdx],
        items: nextCategories[catIdx].items.filter((_, index) => index !== itemIdx),
      };

      return {
        ...currentDraft,
        categories: nextCategories,
      };
    });
  };

  const updateReviewLineTarget = (line, field, value) => {
    setReviewLineTargets((currentTargets) => ({
      ...currentTargets,
      [reviewLineIdentity(line)]: {
        ...(currentTargets[reviewLineIdentity(line)] || {}),
        [field]: value,
      },
    }));
  };

  const consumeReviewLine = (currentDraft, line) => {
    const matchesLine = (candidate) => reviewLineIdentity(candidate) === reviewLineIdentity(line);

    return {
      ...currentDraft,
      suspiciousLines: currentDraft.suspiciousLines.filter((candidate) => !matchesLine(candidate)),
      discardedLines: currentDraft.discardedLines.filter((candidate) => !matchesLine(candidate)),
    };
  };

  const getSelectedReviewTarget = (currentDraft, line) => {
    const lineKey = reviewLineIdentity(line);
    const explicitTarget = reviewLineTargets[lineKey];

    if (explicitTarget) {
      return resolveReviewTarget(explicitTarget, currentDraft.categories);
    }

    return getPreferredReviewTarget(line, currentDraft.categories, lastReviewTarget);
  };

  const getPrimaryReviewAction = (line, selectedCategoryIndex, hasSpecificItemTarget) => {
    if (hasSpecificItemTarget && isDescriptionLikeLine(line)) {
      return 'use-description';
    }

    if (Number.isInteger(selectedCategoryIndex)) {
      return 'move-category';
    }

    return 'convert-item';
  };

  const applyReviewLineAction = (line, action) => {
    setMenuActionError('');
    setMenuActionSuccess('');
    const pendingEntries = buildPendingReviewEntries(parsedMenu);
    const currentLineId = reviewLineIdentity(line);
    const currentLineIndex = pendingEntries.findIndex((entry) => entry.id === currentLineId);
    const nextPendingLineId = pendingEntries[currentLineIndex + 1]?.id
      || pendingEntries[currentLineIndex - 1]?.id
      || '';

    if (action === 'use-description' && parsedMenu) {
      const selectedTarget = resolveReviewTarget(
        reviewLineTargets[reviewLineIdentity(line)],
        parsedMenu.categories
      );
      const parsedCategoryIndex = Number.parseInt(selectedTarget.categoryIndex, 10);
      const parsedItemIndex = Number.parseInt(selectedTarget.itemIndex, 10);
      const selectedCategory = Number.isInteger(parsedCategoryIndex) ? parsedMenu.categories?.[parsedCategoryIndex] : null;
      const selectedItem = Number.isInteger(parsedItemIndex) ? selectedCategory?.items?.[parsedItemIndex] : null;

      if (!selectedCategory || !selectedItem) {
        setMenuActionError('Elegí un plato específico para usar esta línea como descripción.');
        return;
      }
    }

    let nextRememberedTarget = null;
    let nextHighlightedTarget = null;

    setParsedMenu((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      const baseDraft = consumeReviewLine(currentDraft, line);
      const selectedTarget = getSelectedReviewTarget(baseDraft, line);
      const selectedCategoryIndex = Number.parseInt(selectedTarget.categoryIndex, 10);
      const selectedItemIndex = Number.parseInt(selectedTarget.itemIndex, 10);
      let nextCategories = [...baseDraft.categories];

      if (action === 'ignore') {
        return baseDraft;
      }

      if (action === 'new-category') {
        nextCategories = [
          ...nextCategories,
          {
            name: line.text || 'Nueva categoría',
            confidence: null,
            reviewCount: 0,
            flags: [],
            items: [],
          },
        ];

        nextRememberedTarget = {
          categoryIndex: String(nextCategories.length - 1),
          itemIndex: '',
        };
        nextHighlightedTarget = nextRememberedTarget;

        return {
          ...baseDraft,
          categories: nextCategories,
        };
      }

      if (action === 'convert-item') {
        let recoveredCategoryIndex = nextCategories.findIndex((category) => category.name === 'Rescatados del OCR');

        if (recoveredCategoryIndex === -1) {
          nextCategories = [...nextCategories, createRecoveredCategory()];
          recoveredCategoryIndex = nextCategories.length - 1;
        }

        nextCategories[recoveredCategoryIndex] = {
          ...nextCategories[recoveredCategoryIndex],
          items: [...nextCategories[recoveredCategoryIndex].items, createItemFromReviewLine(line)],
        };

        nextRememberedTarget = {
          categoryIndex: String(recoveredCategoryIndex),
          itemIndex: String(nextCategories[recoveredCategoryIndex].items.length - 1),
        };
        nextHighlightedTarget = nextRememberedTarget;

        return {
          ...baseDraft,
          categories: nextCategories,
        };
      }

      if (action === 'move-category') {
        if (!Number.isInteger(selectedCategoryIndex)) {
          return {
            ...baseDraft,
            categories: [...nextCategories, { ...createRecoveredCategory(), items: [createItemFromReviewLine(line)] }],
          };
        }

        nextCategories[selectedCategoryIndex] = {
          ...nextCategories[selectedCategoryIndex],
          items: [...nextCategories[selectedCategoryIndex].items, createItemFromReviewLine(line)],
        };

        nextRememberedTarget = {
          categoryIndex: String(selectedCategoryIndex),
          itemIndex: String(nextCategories[selectedCategoryIndex].items.length - 1),
        };
        nextHighlightedTarget = nextRememberedTarget;

        return {
          ...baseDraft,
          categories: nextCategories,
        };
      }

      if (action === 'use-description') {
        if (!Number.isInteger(selectedCategoryIndex) || !Number.isInteger(selectedItemIndex)) {
          return currentDraft;
        }

        const nextItems = [...nextCategories[selectedCategoryIndex].items];
        const targetItem = nextItems[selectedItemIndex];

        nextItems[selectedItemIndex] = {
          ...targetItem,
          description: [targetItem.description, line.text].filter(Boolean).join(' ').trim(),
          flags: Array.from(new Set([...(targetItem.flags || []), 'description_from_review'])),
        };

        nextCategories[selectedCategoryIndex] = {
          ...nextCategories[selectedCategoryIndex],
          items: nextItems,
        };

        nextRememberedTarget = {
          categoryIndex: String(selectedCategoryIndex),
          itemIndex: String(selectedItemIndex),
        };
        nextHighlightedTarget = nextRememberedTarget;

        return {
          ...baseDraft,
          categories: nextCategories,
        };
      }

      return baseDraft;
    });

    const successMessages = {
      ignore: 'Línea ignorada en esta revisión.',
      'new-category': 'La línea quedó convertida en una nueva categoría.',
      'convert-item': 'La línea quedó agregada como item recuperado.',
      'move-category': 'La línea se movió a la categoría elegida.',
      'use-description': 'La línea quedó agregada como descripción del plato elegido.',
    };

    if (nextRememberedTarget) {
      setLastReviewTarget(nextRememberedTarget);
    }

    if (nextHighlightedTarget) {
      setHighlightedReviewTarget(nextHighlightedTarget);
    }

    setReviewStats((currentStats) => ({
      rescued: currentStats.rescued + (action === 'ignore' ? 0 : 1),
      ignored: currentStats.ignored + (action === 'ignore' ? 1 : 0),
    }));
    setActiveReviewLineId(nextPendingLineId);

    setMenuActionSuccess(successMessages[action] || 'Cambio aplicado al borrador.');
  };

  const openOrders = orders.filter((order) => !order.closed_at);
  const pendingOrders = openOrders.filter((order) => order.status === 'pending');
  const processingOrders = openOrders.filter((order) => order.status === 'processing');
  const readyOrders = openOrders.filter((order) => order.status === 'ready');
  const deliveredOrders = openOrders.filter((order) => order.status === 'delivered');
  const pendingTableRequests = [...tableRequests]
    .filter((request) => request.status === 'pending')
    .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
  const resolvedTableRequests = [...tableRequests]
    .filter((request) => request.status === 'resolved')
    .sort((left, right) => new Date(right.resolved_at || right.created_at).getTime() - new Date(left.resolved_at || left.created_at).getTime());
  const socketConfig = SOCKET_STATUS_CONFIG[socketStatus] || SOCKET_STATUS_CONFIG.disconnected;
  const previewImageSrc = parsedMenu?.previewImages?.find((preview) => preview.name === previewMode)?.data_url
    || parsedMenu?.previewImages?.[0]?.data_url
    || filePreviewUrl;
  const reviewFocus = parsedMenu?.diagnostics?.review_focus || null;
  const reviewQueue = parsedMenu?.diagnostics?.review_queue || [];
  const ocrCandidates = parsedMenu?.diagnostics?.ocr_candidates || [];
  const pendingReviewEntries = buildPendingReviewEntries(parsedMenu);
  const pendingReviewCount = pendingReviewEntries.length;
  const suspiciousLineIds = new Set((parsedMenu?.suspiciousLines || []).map(reviewLineIdentity));
  const discardedReviewLines = (parsedMenu?.discardedLines || []).filter((line) => !suspiciousLineIds.has(reviewLineIdentity(line)));
  const isManualDraft = parsedMenu?.draftSource === 'manual';
  const isLight = theme === 'light';
  const historySummaryMetrics = historySummary?.summary || {
    orders_count: 0,
    total_revenue: 0,
    average_ticket: 0,
    average_prep_minutes: null,
    average_service_minutes: null,
    average_to_payment_minutes: null,
  };
  const historyPaymentBreakdown = Array.isArray(historySummary?.payment_breakdown) ? historySummary.payment_breakdown : [];

  const renderReviewLineCard = (line, index, sourceLabel) => {
    const lineKey = reviewLineIdentity(line);
    const selectedTarget = reviewLineTargets[lineKey]
      ? resolveReviewTarget(reviewLineTargets[lineKey], parsedMenu?.categories || [])
      : getPreferredReviewTarget(line, parsedMenu?.categories || [], lastReviewTarget);
    const selectedCategoryIndex = Number.parseInt(selectedTarget.categoryIndex, 10);
    const selectedCategory = Number.isInteger(selectedCategoryIndex) ? parsedMenu?.categories?.[selectedCategoryIndex] : null;
    const selectedCategoryItems = selectedCategory?.items || [];
    const hasSpecificItemTarget = Number.isInteger(Number.parseInt(selectedTarget.itemIndex, 10)) && selectedCategoryItems.length > 0;
    const selectedItemIndex = Number.parseInt(selectedTarget.itemIndex, 10);
    const selectedItem = Number.isInteger(selectedItemIndex) ? selectedCategoryItems[selectedItemIndex] : null;
    const primaryAction = getPrimaryReviewAction(line, selectedCategoryIndex, hasSpecificItemTarget);

    return (
      <div
        key={`${sourceLabel}-${lineKey}-${index}`}
        ref={(node) => {
          if (node) {
            reviewLineRefs.current.set(lineKey, node);
            return;
          }

          reviewLineRefs.current.delete(lineKey);
        }}
        tabIndex={0}
        onFocus={() => setActiveReviewLineId(lineKey)}
        onClick={() => setActiveReviewLineId(lineKey)}
        onKeyDown={(event) => {
          const tagName = event.target instanceof HTMLElement ? event.target.tagName : '';
          const isButton = tagName === 'BUTTON';
          const isSelect = tagName === 'SELECT';

          if (event.key === 'Escape') {
            if (isSelect && event.target instanceof HTMLElement) {
              event.preventDefault();
              event.target.blur();
              return;
            }

            event.preventDefault();
            applyReviewLineAction(line, 'ignore');
            return;
          }

          if (event.key === 'Enter' && !isButton && !isSelect) {
            event.preventDefault();
            applyReviewLineAction(line, primaryAction);
          }
        }}
        className={`menu-import-discarded-item menu-import-review-line is-pending ${activeReviewLineId === lineKey ? 'is-active' : ''}`}
      >
        <div className="menu-import-review-line-head">
          <div>
            <div className="menu-import-review-line-meta">
              <span className="menu-review-flag">Pendiente</span>
              {primaryAction === 'use-description' && (
                <span className="menu-review-flag">Enter: descripción rápida</span>
              )}
            </div>
            <strong>{line.text}</strong>
            <span>{formatReviewReason(line.reason)}</span>
          </div>
          {line.confidence !== undefined && line.confidence !== null && (
            <span className={`menu-review-quality-badge ${line.confidence >= 85 ? 'is-high' : line.confidence >= 70 ? 'is-medium' : 'is-low'}`}>
              Conf. {Math.round(line.confidence)}
            </span>
          )}
        </div>

        <div className="menu-import-review-line-targets">
          <label className="menu-import-review-line-select">
            <span>Categoría</span>
            <select
              value={selectedTarget.categoryIndex}
              onChange={(event) => {
                const nextCategoryIndex = event.target.value;
                const nextCategory = parsedMenu?.categories?.[Number.parseInt(nextCategoryIndex, 10)];
                const nextItems = nextCategory?.items || [];

                updateReviewLineTarget(line, 'categoryIndex', nextCategoryIndex);
                updateReviewLineTarget(
                  line,
                  'itemIndex',
                  getProbableItemIndex(line, nextItems, lastReviewTarget, nextCategoryIndex)
                );
              }}
            >
              {parsedMenu?.categories?.map((category, categoryIndex) => (
                <option key={`${lineKey}-${category.name}-${categoryIndex}`} value={categoryIndex}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <label className="menu-import-review-line-select">
            <span>Plato sugerido</span>
            <select
              value={selectedTarget.itemIndex}
              onChange={(event) => updateReviewLineTarget(line, 'itemIndex', event.target.value)}
              disabled={selectedCategoryItems.length === 0}
            >
              {selectedCategoryItems.length === 0 ? (
                <option value="">La categoría no tiene platos</option>
              ) : (
                selectedCategoryItems.map((item, itemIndex) => (
                  <option key={`${lineKey}-${selectedCategoryIndex}-${item.name}-${itemIndex}`} value={itemIndex}>
                    {item.name || `Plato ${itemIndex + 1}`}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>

        {(selectedCategory || selectedItem) && (
          <div className="menu-import-review-line-summary">
            <span>
              Destino sugerido:
              {' '}
              <strong>{selectedCategory?.name || 'Sin categoría'}</strong>
              {selectedItem ? ` -> ${selectedItem.name}` : ''}
            </span>
          </div>
        )}

        <div className="menu-import-review-line-actions">
          <button
            className={`btn ${primaryAction === 'use-description' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => applyReviewLineAction(line, 'use-description')}
            disabled={!hasSpecificItemTarget}
          >
            Descripción rápida
          </button>
          <button
            className={`btn ${primaryAction === 'move-category' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => applyReviewLineAction(line, 'move-category')}
          >
            Mover
          </button>
          <button
            className={`btn ${primaryAction === 'convert-item' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => applyReviewLineAction(line, 'convert-item')}
          >
            Item
          </button>
          <button className="btn" type="button" onClick={() => applyReviewLineAction(line, 'new-category')}>
            Nueva categoría
          </button>
          <button className="btn" type="button" onClick={() => applyReviewLineAction(line, 'ignore')}>
            Ignorar
          </button>
        </div>
      </div>
    );
  };

  const renderOrderCard = (order) => {
    const selectedPaymentMethod = paymentMethodDrafts[order.id] || order.payment_method || 'cash';

    return (
    <div className={`order-card ${order.status === 'delivered' ? 'is-delivered' : ''}`} key={order.id}>
      <div className="order-header">
        <span className={`admin-badge ${getTableBadgeClass(order.table_id)}`}>Mesa {order.table_id}</span>
        <div className="table-request-card-meta-row">
          <span className="time">Entró {formatOrderTime(order.created_at)}</span>
          <span className="admin-badge is-info">{formatMenuMoney(order.total_amount)}</span>
        </div>
      </div>
      <div className="order-timeline">
        <span className="order-timeline-item">
          <strong>Entró</strong>
          <span>{formatOrderTime(order.created_at)}</span>
        </span>
        {order.ready_at && (
          <span className="order-timeline-item">
            <strong>Listo</strong>
            <span>{formatOrderTime(order.ready_at)}</span>
          </span>
        )}
        {order.delivered_at && (
          <span className="order-timeline-item">
            <strong>Salió</strong>
            <span>{formatOrderTime(order.delivered_at)}</span>
          </span>
        )}
        {order.bill_requested_at && (
          <span className="order-timeline-item">
            <strong>Cuenta pedida</strong>
            <span>{formatOrderTime(order.bill_requested_at)}</span>
          </span>
        )}
        {order.bill_attended_at && (
          <span className="order-timeline-item">
            <strong>Cuenta entregada</strong>
            <span>{formatOrderTime(order.bill_attended_at)}</span>
          </span>
        )}
        {order.payment_received_at && (
          <span className="order-timeline-item">
            <strong>Pago</strong>
            <span>{formatOrderTime(order.payment_received_at)}</span>
          </span>
        )}
        {order.ready_at && (
          <span className="order-timeline-item is-summary">
            <strong>Preparación</strong>
            <span>{formatDurationMinutes(order.created_at, order.ready_at)}</span>
          </span>
        )}
        {order.delivered_at && (
          <span className="order-timeline-item is-summary">
            <strong>Servicio</strong>
            <span>{formatDurationMinutes(order.created_at, order.delivered_at)}</span>
          </span>
        )}
      </div>
      <ul className="order-items-list">
        {order.items.map((item, idx) => (
          <li key={idx}>
            <span className="item-qty">{item.quantity}x</span> {item.name}
            {item.comments && <span className="item-comment">"{item.comments}"</span>}
          </li>
        ))}
      </ul>
      <div className="order-header">
        <div className="table-request-card-meta-row">
          {order.bill_requested_at && (
            <span className="admin-badge is-danger">Cuenta pedida</span>
          )}
          {order.bill_attended_at && (
            <span className="admin-badge is-success">Cuenta entregada</span>
          )}
          {order.payment_received_at && (
            <span className="admin-badge is-success">Pago recibido</span>
          )}
          {order.payment_method && (
            <span className="admin-badge is-info">{formatPaymentMethodLabel(order.payment_method)}</span>
          )}
        </div>
      </div>
      <div className="order-actions">
        {order.status === 'pending' && (
          <button
            className="btn admin-outline-action is-warning"
            onClick={() => updateStatus(order.id, 'processing')}
            disabled={socketStatus !== 'connected'}
          >
            <Play size={16} /> Preparar
          </button>
        )}
        {order.status === 'processing' && (
          <button
            className="btn admin-outline-action is-success"
            onClick={() => updateStatus(order.id, 'ready')}
            disabled={socketStatus !== 'connected'}
          >
            <Check size={16} /> Listo
          </button>
        )}
        {order.status === 'ready' && (
          <button
            className="btn admin-outline-action is-success"
            onClick={() => updateStatus(order.id, 'delivered')}
            disabled={socketStatus !== 'connected'}
          >
            <Check size={16} /> Entregado
          </button>
        )}
        {order.status === 'delivered' && (
          <>
            {!order.bill_attended_at && order.bill_requested_at && (
              <div className="order-economic-note">
                La cuenta todavía no fue entregada. Marcala desde Solicitudes de salón.
              </div>
            )}
            {order.bill_attended_at && !order.payment_received_at && (
              <div className="order-economic-controls">
                <label className="order-payment-field">
                  <span>Medio de pago</span>
                  <select
                    value={selectedPaymentMethod}
                    onChange={(event) => updatePaymentMethodDraft(order.id, event.target.value)}
                    disabled={payingTableId === order.table_id || socketStatus !== 'connected'}
                  >
                    {PAYMENT_METHOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn admin-outline-action is-success"
                  onClick={() => recordPayment(order)}
                  disabled={payingTableId === order.table_id || socketStatus !== 'connected'}
                >
                  <Check size={16} /> {payingTableId === order.table_id ? 'Registrando...' : 'Marcar cobrada'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    );
  };

  const renderHistoryOrderCard = (order) => {
    const isExpanded = historyExpandedOrderId === order.id;

    return (
      <div className="glass-panel history-order-card" key={`history-${order.id}`}>
        <div className="history-order-head">
          <div>
            <span className={`admin-badge ${getTableBadgeClass(order.table_id)}`}>Mesa {order.table_id}</span>
            <h3>Pedido #{order.id}</h3>
            <span className="history-order-meta">
              Cerrado {formatOrderDateTime(order.closed_at)}
            </span>
          </div>
          <div className="history-order-summary">
            <span className="admin-badge is-info">{formatMenuMoney(order.total_amount)}</span>
            <span className="admin-badge is-success">{formatHistoryPaymentMethod(order.payment_method)}</span>
          </div>
        </div>

        <div className="history-order-metrics">
          <span className="history-metric-chip">
            Preparación: <strong>{formatHistoryMinutes(order?.durations?.prep_minutes)}</strong>
          </span>
          <span className="history-metric-chip">
            Servicio: <strong>{formatHistoryMinutes(order?.durations?.service_minutes)}</strong>
          </span>
          <span className="history-metric-chip">
            Cobro: <strong>{formatHistoryMinutes(order?.durations?.to_payment_minutes)}</strong>
          </span>
        </div>

        <div className="history-order-actions">
          <button
            className="btn"
            type="button"
            onClick={() => setHistoryExpandedOrderId((current) => (current === order.id ? null : order.id))}
          >
            {isExpanded ? 'Ocultar detalle' : 'Ver detalle'}
          </button>
        </div>

        {isExpanded && (
          <div className="history-order-detail">
            <div className="history-order-timeline">
              <span><strong>Entró:</strong> {formatOrderDateTime(order.created_at) || '—'}</span>
              <span><strong>Listo:</strong> {formatOrderDateTime(order.ready_at) || '—'}</span>
              <span><strong>Entregado:</strong> {formatOrderDateTime(order.delivered_at) || '—'}</span>
              <span><strong>Cuenta pedida:</strong> {formatOrderDateTime(order.bill_requested_at) || '—'}</span>
              <span><strong>Cuenta entregada:</strong> {formatOrderDateTime(order.bill_attended_at) || '—'}</span>
              <span><strong>Pago recibido:</strong> {formatOrderDateTime(order.payment_received_at) || '—'}</span>
            </div>
            <ul className="order-items-list">
              {(order.items || []).map((item, index) => (
                <li key={`history-item-${order.id}-${item.item_id}-${index}`}>
                  <span className="item-qty">{item.quantity}x</span> {item.name}
                  <span className="history-item-price">{formatMenuMoney(item.price * item.quantity)}</span>
                  {item.comments && <span className="item-comment">"{item.comments}"</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  const renderTableRequestCard = (request) => (
    <div
      className={`table-request-card ${request.status === 'pending' ? 'is-pending' : 'is-resolved'} ${TABLE_REQUEST_TYPE_CONFIG[request.type]?.className || ''}`}
      key={request.id}
    >
      <div className="table-request-card-head">
        <div className="table-request-card-head-main">
          <div className="table-request-card-icon">
            {(() => {
              const RequestIcon = TABLE_REQUEST_TYPE_CONFIG[request.type]?.icon || Bell;
              return <RequestIcon size={24} />;
            })()}
          </div>
          <div className="table-request-card-copy">
            <div className="table-request-card-meta-row">
              <span className={`admin-badge ${getTableBadgeClass(request.table_id)}`}>Mesa {request.table_id}</span>
              <span className={`admin-badge ${request.status === 'pending' ? 'is-danger' : 'is-success'}`}>
                {request.status === 'pending' ? 'Pendiente' : 'Resuelta'}
              </span>
            </div>
            <strong>{TABLE_REQUEST_LABELS[request.type] || request.type}</strong>
          </div>
        </div>
      </div>
      <p>
        {request.status === 'pending'
          ? TABLE_REQUEST_TYPE_CONFIG[request.type]?.helper || 'La mesa está esperando una acción del salón.'
          : request.type === 'request_bill'
            ? 'La cuenta ya fue entregada.'
            : 'Ya fue atendida por el equipo.'}
      </p>
      <div className="table-request-card-meta">
        <span>Entró {new Date(request.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {request.resolved_at && (
          <span>Resuelta {new Date(request.resolved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        )}
      </div>
      {request.status === 'pending' && (
        <button
          className="btn admin-outline-action is-success"
          onClick={() => resolvePendingTableRequest(request.id)}
          disabled={resolvingRequestId === request.id || socketStatus !== 'connected'}
        >
          <Check size={16} /> {resolvingRequestId === request.id
            ? 'Marcando...'
            : request.type === 'request_bill'
              ? 'Cuenta entregada'
              : 'Marcar resuelta'}
        </button>
      )}
    </div>
  );

  return (
    <div className={`app-container admin-shell ${isLight ? 'admin-theme-light' : ''}`}>
      <header className="app-header admin-shell-header">
        <div className="admin-shell-brand">
          <div className="logo">
            <ChefHat size={32} color="var(--accent-color)" />
            <span>{adminRestaurantName} Admin</span>
          </div>
          <p className="admin-shell-subtitle">{adminSubtitle}</p>
        </div>
        <div className="admin-shell-actions">
          <button
            className="theme-toggle admin-theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
            title={isLight ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
          >
            {isLight ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <span
            className={`admin-connection-led ${socketStatus === 'connected' ? 'is-success' : socketStatus === 'reconnecting' ? 'is-warning' : 'is-danger'}`}
            aria-label={socketConfig.label}
            title={socketConfig.label}
          >
            <span className="admin-connection-led-dot" />
          </span>
          <button className="btn" onClick={onLogout}><LogOut size={16} /> Salir</button>
        </div>
      </header>

      <div className="glass-panel admin-nav-tabs">
        <button
          className={`btn ${activeTab === 'kanban' ? 'btn-primary' : ''}`}
          type="button"
          onClick={() => setActiveTab('kanban')}
        >
          Tablero Realtime
        </button>
        <button
          className={`btn ${activeTab === 'menu_import' ? 'btn-primary' : ''}`}
          type="button"
          onClick={focusImportFlow}
        >
          Importar Menú (Foto)
        </button>
        <button
          className={`btn ${activeTab === 'history' ? 'btn-primary' : ''}`}
          type="button"
          onClick={openHistory}
        >
          Historial
        </button>
        <button
          className={`btn ${activeTab === 'venue_settings' ? 'btn-primary' : ''}`}
          type="button"
          onClick={openVenueSettings}
        >
          Configurar Local
        </button>
      </div>

      {activeTab === 'kanban' && (
        <>
          <div className="admin-toolbar">
            <button className="btn" type="button" onClick={openAddTableModal}>
              <Plus size={16} /> Agregar mesa
            </button>
          </div>

          {ordersActionError && (
            <div className="admin-alert is-error">
              <strong className="admin-alert-title">No pudimos actualizar el pedido.</strong>
              <span className="admin-alert-copy">{ordersActionError}</span>
            </div>
          )}

          {tableRequestsActionError && (
            <div className="admin-alert is-error">
              <strong className="admin-alert-title">No pudimos actualizar la solicitud de mesa.</strong>
              <span className="admin-alert-copy">{tableRequestsActionError}</span>
            </div>
          )}

          <section className="table-request-board glass-panel">
            <div className="table-request-board-head">
              <div>
                <span className="admin-pill">Solicitudes de salón</span>
                <h2>Solicitudes activas</h2>
              </div>
              <div className="table-request-board-actions">
                <span className={`admin-badge ${pendingTableRequests.length > 0 ? 'is-danger' : 'is-muted'}`}>
                  {pendingTableRequests.length} pendiente{pendingTableRequests.length === 1 ? '' : 's'}
                </span>
                {resolvedTableRequests.length > 0 && (
                  <button
                    className="btn table-request-history-toggle"
                    type="button"
                    onClick={() => setShowResolvedTableRequests((current) => !current)}
                  >
                    {showResolvedTableRequests ? 'Ocultar resueltas' : `Ver resueltas (${resolvedTableRequests.length})`}
                  </button>
                )}
              </div>
            </div>

            {tableRequestsStatus === 'loading' && <div className="loader"></div>}

            {tableRequestsStatus === 'error' && (
              <div className="status-card status-card-error admin-status-card">
                <div>
                  <strong>No pudimos cargar las solicitudes de mesa.</strong>
                  <span>{tableRequestsError}</span>
                </div>
                <button className="btn" onClick={() => setOrdersReloadKey((current) => current + 1)}>
                  Reintentar
                </button>
              </div>
            )}

            {tableRequestsStatus === 'empty' && (
              <div className="order-empty-state">
                <Clock size={22} />
                <div>
                  <strong>Sin solicitudes activas.</strong>
                  <span>Cuando una mesa pida mozo o cuenta va a aparecer acá en vivo.</span>
                </div>
              </div>
            )}

            {pendingTableRequests.length > 0 && (
              <div className="table-request-stack">
                {pendingTableRequests.map(renderTableRequestCard)}
              </div>
            )}

            {resolvedTableRequests.length > 0 && (
              <div className="table-request-history">
                {showResolvedTableRequests && (
                  <div className="table-request-stack is-history">
                    {resolvedTableRequests.map(renderTableRequestCard)}
                  </div>
                )}
              </div>
            )}
          </section>

          {ordersStatus === 'loading' && <div className="loader"></div>}

          {ordersStatus === 'error' && openOrders.length === 0 && (
            <div className="glass-panel admin-empty-state">
              <h2>No pudimos cargar los pedidos.</h2>
              <p>{ordersError}</p>
              <button className="btn btn-primary" onClick={() => setOrdersReloadKey((current) => current + 1)}>
                Reintentar
              </button>
            </div>
          )}

          {ordersStatus === 'error' && openOrders.length > 0 && (
            <div className="admin-alert is-error">
              <strong className="admin-alert-title">El tablero quedó visible, pero no pudimos refrescar los pedidos.</strong>
              <span className="admin-alert-copy">{ordersError}</span>
              <div className="admin-alert-actions">
                <button className="btn" onClick={() => setOrdersReloadKey((current) => current + 1)}>
                  Reintentar
                </button>
              </div>
            </div>
          )}

          {ordersStatus === 'empty' && (
            <div className="glass-panel admin-empty-state">
              <h2>No hay pedidos abiertos.</h2>
              <p>
                Cuando entre un nuevo pedido desde una mesa, va a aparecer acá en tiempo real.
              </p>
            </div>
          )}

          {openOrders.length > 0 && (
            <>
            <div className="admin-grid">
              <div className="admin-column is-pending">
                <div className="column-header">
                  <Clock size={20} color="var(--danger)" /> Pendientes <span className="badge">{pendingOrders.length}</span>
                </div>
                {pendingOrders.map(renderOrderCard)}
              </div>
              <div className="admin-column is-processing">
                <div className="column-header">
                  <Play size={20} color="var(--warning)" /> En Preparación <span className="badge">{processingOrders.length}</span>
                </div>
                {processingOrders.map(renderOrderCard)}
              </div>
              <div className="admin-column is-ready">
                <div className="column-header">
                  <Check size={20} color="var(--success)" /> Listos <span className="badge">{readyOrders.length}</span>
                </div>
                {readyOrders.map(renderOrderCard)}
              </div>
            </div>
            {deliveredOrders.length > 0 && (
              <div className="delivered-history-panel glass-panel">
                <div className="delivered-history-head">
                  <div>
                    <span className="admin-pill">Entregados</span>
                    <h3>Pedidos entregados pendientes de cobro</h3>
                  </div>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setShowDeliveredOrders((current) => !current)}
                  >
                    {showDeliveredOrders ? 'Ocultar entregados' : `Ver entregados (${deliveredOrders.length})`}
                  </button>
                </div>
                {showDeliveredOrders && (
                  <div className="delivered-history-list">
                    {deliveredOrders.map(renderOrderCard)}
                  </div>
                )}
              </div>
            )}
            </>
          )}
        </>
      )}

      {activeTab === 'history' && (
        <section className="history-tab-shell">
          <div className="glass-panel history-filters-panel">
            <div className="history-filters-head">
              <div>
                <h2 className="admin-section-title">Historial operativo</h2>
                <p className="admin-section-copy">
                  Solo muestra pedidos cobrados y cerrados. El período se calcula por fecha de cierre.
                </p>
              </div>
            </div>

            <div className="history-preset-row">
              {HISTORY_PRESET_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`btn ${!historyFiltersDraft.from && !historyFiltersDraft.to && historyFiltersDraft.preset === option.value ? 'btn-primary' : ''}`}
                  type="button"
                  onClick={() => applyHistoryPreset(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="history-filters-grid">
              <label className="settings-field">
                <span>Desde</span>
                <input
                  className="admin-input admin-input--compact"
                  type="date"
                  value={historyFiltersDraft.from}
                  onChange={(event) => updateHistoryDraftField('from', event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Hasta</span>
                <input
                  className="admin-input admin-input--compact"
                  type="date"
                  value={historyFiltersDraft.to}
                  onChange={(event) => updateHistoryDraftField('to', event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Medio de pago</span>
                <select
                  className="admin-input admin-input--compact"
                  value={historyFiltersDraft.payment_method}
                  onChange={(event) => updateHistoryDraftField('payment_method', event.target.value)}
                >
                  {HISTORY_PAYMENT_METHOD_OPTIONS.map((option) => (
                    <option key={option.value || 'all'} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="history-filter-actions">
                <button className="btn btn-primary" type="button" onClick={applyHistoryFilters}>
                  Aplicar
                </button>
                <button className="btn" type="button" onClick={clearHistoryFilters}>
                  Limpiar
                </button>
              </div>
            </div>
          </div>

          {historySummaryStatus === 'error' && (
            <div className="admin-alert is-error">
              <strong className="admin-alert-title">No pudimos cargar el resumen.</strong>
              <span className="admin-alert-copy">{historySummaryError}</span>
            </div>
          )}

          {historySummaryStatus === 'ready' && (
            <div className="history-summary-grid">
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Pedidos</span>
                <strong>{historySummaryMetrics.orders_count}</strong>
                <span>Cobrados en el período</span>
              </div>
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Total cobrado</span>
                <strong>{formatMenuMoney(historySummaryMetrics.total_revenue)}</strong>
                <span>Ingresos cerrados</span>
              </div>
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Ticket promedio</span>
                <strong>{formatMenuMoney(historySummaryMetrics.average_ticket)}</strong>
                <span>Promedio por pedido</span>
              </div>
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Prep. promedio</span>
                <strong>{formatHistoryMinutes(historySummaryMetrics.average_prep_minutes)}</strong>
                <span>Hasta listo</span>
              </div>
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Servicio promedio</span>
                <strong>{formatHistoryMinutes(historySummaryMetrics.average_service_minutes)}</strong>
                <span>Hasta entregado</span>
              </div>
              <div className="glass-panel history-summary-card">
                <span className="admin-pill">Cobro promedio</span>
                <strong>{formatHistoryMinutes(historySummaryMetrics.average_to_payment_minutes)}</strong>
                <span>Hasta pago registrado</span>
              </div>
            </div>
          )}

          {historySummaryStatus === 'ready' && (
            <div className="glass-panel history-breakdown-panel">
              <div className="history-breakdown-head">
                <div>
                  <span className="admin-pill">Medios de pago</span>
                  <h3>Desglose simple del período</h3>
                </div>
              </div>
              {historyPaymentBreakdown.length > 0 ? (
                <div className="history-breakdown-list">
                  {historyPaymentBreakdown.map((entry) => (
                    <div className="history-breakdown-item" key={`breakdown-${entry.payment_method}`}>
                      <strong>{formatHistoryPaymentMethod(entry.payment_method)}</strong>
                      <span>{entry.orders_count} pedido(s)</span>
                      <span>{formatMenuMoney(entry.total_revenue)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="order-empty-state">
                  <Receipt size={20} />
                  <div>
                    <strong>Sin cobros en el período.</strong>
                    <span>Cuando cierres mesas cobradas, van a aparecer acá.</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {historyOrdersStatus === 'loading' && <div className="loader"></div>}

          {historyOrdersStatus === 'error' && (
            <div className="admin-alert is-error">
              <strong className="admin-alert-title">No pudimos cargar el historial.</strong>
              <span className="admin-alert-copy">{historyOrdersError}</span>
            </div>
          )}

          {historyOrdersStatus === 'empty' && (
            <div className="glass-panel admin-empty-state">
              <h2>No hay pedidos cobrados para ese filtro.</h2>
              <p>Probá otro rango o esperá a que haya mesas cerradas en el período seleccionado.</p>
            </div>
          )}

          {historyOrdersStatus === 'ready' && (
            <div className="history-orders-list">
              {historyOrders.map(renderHistoryOrderCard)}
            </div>
          )}
        </section>
      )}

      {activeTab === 'menu_import' && (
          <div className="glass-panel admin-section-card admin-section-card--import">
             <div className="admin-card-head admin-import-head">
               <div>
                 <h2 className="admin-section-title">Importar menú</h2>
                 <p className="admin-section-copy">
                   Elegí cómo querés armar el borrador. Después lo revisás y lo publicás desde el mismo editor.
                 </p>
               </div>
               <button className="btn" type="button" onClick={() => setActiveTab('kanban')}>
                 <X size={16} /> Cerrar importación
               </button>
             </div>

             {activeMenuInfo ? (
               <div className="glass-panel admin-section-card admin-card-emphasis is-danger">
                 <div className="admin-card-head">
                   <div>
                     <strong className="admin-card-title">Menú publicado</strong>
                     <span className="admin-card-copy">
                       {activeMenuInfo.name} · {activeMenuInfo.category_count} {activeMenuInfo.category_count === 1 ? 'categoría' : 'categorías'} · {activeMenuInfo.item_count} {activeMenuInfo.item_count === 1 ? 'ítem' : 'ítems'}
                     </span>
                   </div>
                   <div className="admin-card-actions-stack">
                     <button
                       className="btn admin-outline-action is-danger"
                       onClick={() => setShowClearMenuConfirm(true)}
                       disabled={isClearingMenu || isPublishing || isProcessing}
                     >
                       <Trash2 size={16} /> Vaciar menú publicado
                     </button>
                     <span className="admin-card-note">
                       Elimina el menú visible para los clientes, pero no afecta pedidos ni historial.
                     </span>
                   </div>
                 </div>
               </div>
             ) : (
               <div className="glass-panel admin-section-card admin-card-emphasis">
                 <div className="admin-card-head">
                   <div>
                     <strong className="admin-card-title">No hay menú publicado</strong>
                     <span className="admin-card-copy">
                       Creá o importá un menú nuevo para volver a publicarlo.
                     </span>
                   </div>
                   <button className="btn btn-primary" type="button" onClick={focusImportFlow}>
                     <Upload size={16} /> Importar menú
                   </button>
                 </div>
               </div>
             )}

             {menuActionError && (
               <div className="admin-alert is-error">
                 <strong className="admin-alert-title">La acción no se pudo completar.</strong>
                 <span className="admin-alert-copy">{menuActionError}</span>
               </div>
             )}

             {menuActionSuccess && (
               <div className="admin-alert is-success">
                 <strong className="admin-alert-title">Operación exitosa.</strong>
                 <span className="admin-alert-copy">{menuActionSuccess}</span>
               </div>
             )}

             {activeMenuInfo && !parsedMenu && (
               <div className="glass-panel admin-section-card admin-menu-availability-card">
                 <div className="admin-card-head">
                   <div>
                     <strong className="admin-card-title">Disponibilidad del menú publicado</strong>
                     <span className="admin-card-copy">
                       Apagá o prendé productos del menú visible sin volver a publicarlo.
                     </span>
                   </div>
                 </div>

                 {activeMenuCatalogStatus === 'loading' && (
                   <div className="loader"></div>
                 )}

                 {activeMenuCatalogStatus === 'error' && (
                   <div className="admin-alert is-error is-compact">
                     <strong className="admin-alert-title">No pudimos cargar el menú activo.</strong>
                     <span className="admin-alert-copy">{activeMenuCatalogError}</span>
                   </div>
                 )}

                 {activeMenuCatalogStatus === 'ready' && (
                   <div className="admin-menu-availability-groups">
                     {activeMenuCategories.map((category, categoryIndex) => (
                       <div className="admin-menu-availability-group" key={`${category.id || category.name}-${categoryIndex}`}>
                         <div className="admin-menu-availability-group-head">
                           <strong>{category.name}</strong>
                           <span>{(category.items || []).length} {(category.items || []).length === 1 ? 'ítem' : 'ítems'}</span>
                         </div>

                         <div className="admin-menu-availability-list">
                           {(category.items || []).map((item) => {
                             const isAvailable = !(item.is_available === false || Number(item.is_available) === 0);

                             return (
                               <div
                                 className={`admin-menu-availability-item ${isAvailable ? 'is-available' : 'is-unavailable'}`}
                                 key={item.id}
                               >
                                 <div className="admin-menu-availability-copy">
                                   <div className="admin-menu-availability-meta">
                                     <strong>{item.name}</strong>
                                     <span className={`admin-badge ${isAvailable ? 'is-success' : 'is-danger'}`}>
                                       {isAvailable ? 'Disponible' : 'No disponible'}
                                     </span>
                                   </div>
                                   <span>{item.description || 'Sin descripción.'}</span>
                                 </div>

                                 <div className="admin-menu-availability-actions">
                                   <span className="admin-menu-availability-price">{formatMenuMoney(item.price)}</span>
                                   <button
                                     className={`btn ${isAvailable ? '' : 'btn-primary'}`}
                                     type="button"
                                     onClick={() => toggleMenuItemAvailability(item.id, !isAvailable)}
                                     disabled={togglingMenuItemId === item.id || isPublishing || isClearingMenu || isProcessing}
                                   >
                                     {togglingMenuItemId === item.id
                                       ? 'Guardando...'
                                       : isAvailable
                                         ? <><X size={16} /> Apagar</>
                                         : <><Check size={16} /> Activar</>}
                                   </button>
                                 </div>
                               </div>
                             );
                           })}
                         </div>
                       </div>
                     ))}
                   </div>
                 )}
               </div>
             )}
             
             {!parsedMenu ? (
                 <div className="menu-import-entry-shell">
                   <div className="menu-import-source-switch" ref={importStartRef}>
                     <button
                       className={`btn ${importSource === 'image' ? 'btn-primary' : ''}`}
                       onClick={() => setImportSource('image')}
                       type="button"
                     >
                       <Upload size={16} /> Desde imagen
                     </button>
                     <button
                       className={`btn ${importSource === 'external_ai' ? 'btn-primary' : ''}`}
                       onClick={() => setImportSource('external_ai')}
                       type="button"
                     >
                       <Sparkles size={16} /> IA externa
                     </button>
                     <button
                       className={`btn ${importSource === 'manual' ? 'btn-primary' : ''}`}
                       onClick={() => setImportSource('manual')}
                       type="button"
                     >
                       <Plus size={16} /> Manual
                     </button>
                   </div>

                   {importSource === 'image' ? (
                     <form onSubmit={handleFileUpload} className="menu-import-entry-card">
                       <div>
                         <h3 className="admin-subsection-title">Importar desde imagen</h3>
                         <p className="admin-copy">
                           Subí una foto del menú y convertimos el resultado en un borrador editable antes de publicarlo.
                         </p>
                       </div>

                       {filePreviewUrl && (
                         <div className="menu-import-preview">
                           <img src={filePreviewUrl} alt="Vista previa del menú" />
                         </div>
                       )}

                       <div className="menu-import-upload-dropzone">
                         <input className="admin-file-input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files[0])} />
                       </div>

                       <button className="btn btn-primary" type="submit" disabled={!file || isProcessing}>
                         {isProcessing ? 'Analizando imagen...' : <><Upload size={18}/> Analizar foto del menú</>}
                       </button>
                     </form>
                   ) : importSource === 'external_ai' ? (
                     <div className="menu-import-external-grid">
                       <div className="menu-import-entry-card">
                         <div className="menu-import-external-head">
                           <div>
                             <h3 className="admin-subsection-title">Importar desde IA externa</h3>
                             <p className="admin-copy">
                               Elegí el prompt según la cantidad de fotos, copiá el texto y mandáselo a otra IA junto con las imágenes de tu menú.
                              </p>
                            </div>
                            <button className="btn" type="button" onClick={handleCopyExternalPrompt}>
                             <Copy size={16} /> {promptCopied ? 'Copiado' : 'Copiar prompt'}
                            </button>
                          </div>

                          <div className="menu-import-prompt-switch" role="tablist" aria-label="Tipo de prompt para IA externa">
                            {EXTERNAL_PROMPT_OPTIONS.map((option) => (
                              <button
                                key={option.id}
                                className={`menu-import-prompt-tab ${externalPromptVariant === option.id ? 'is-active' : ''}`}
                                onClick={() => {
                                  setExternalPromptVariant(option.id);
                                  setPromptCopied(false);
                                }}
                                type="button"
                              >
                                <strong>{option.label}</strong>
                                <span>{option.description}</span>
                              </button>
                            ))}
                          </div>

                          <div className="menu-import-inline-note">
                            <strong>Cómo usarlo</strong>
                            <span>
                              Copiá este prompt y mandáselo a la otra IA junto con la foto o las fotos del menú. Después pegá solo el JSON que te devuelva.
                            </span>
                          </div>

                          <textarea
                            className="menu-import-prompt-box"
                           value={selectedPrompt}
                           readOnly
                          />
                       </div>

                       <div className="menu-import-entry-card">
                         <div>
                           <h3 className="admin-subsection-title">Pegá el JSON</h3>
                           <p className="admin-copy">
                             Pegá únicamente el JSON que te devolvió la otra IA. Si vino con explicación o texto extra, copiá solo el bloque JSON.
                           </p>
                         </div>

                         <div className="menu-import-inline-note">
                           <strong>Antes de validar</strong>
                           <span>
                             El formato tiene que traer <code>menu_name</code>, <code>categories</code>, <code>items</code>, <code>description</code> y <code>price</code>. Si un precio no se ve bien, la otra IA debería devolver <code>null</code>.
                           </span>
                         </div>

                         {externalMenuError && (
                           <div className="admin-alert is-error is-compact">
                             <strong className="admin-alert-title">No pudimos validar el JSON.</strong>
                             <span className="admin-alert-copy">{externalMenuError}</span>
                           </div>
                         )}

                         {externalMenuSuccess && (
                           <div className="admin-alert is-success is-compact">
                             <strong className="admin-alert-title">Listo para revisar.</strong>
                             <span className="admin-alert-copy">{externalMenuSuccess}</span>
                           </div>
                         )}

                         <textarea
                           className="menu-import-json-box"
                           value={externalMenuJson}
                           onChange={(event) => {
                             setExternalMenuJson(event.target.value);
                             setValidatedExternalMenu(null);
                             setExternalMenuError('');
                             setExternalMenuSuccess('');
                           }}
                           placeholder={EXTERNAL_AI_MENU_JSON_EXAMPLES.valid}
                         />

                         <div className="menu-import-example-actions">
                           <button
                             className="btn"
                             type="button"
                             onClick={() => handlePasteExternalMenuExample('valid')}
                           >
                             Pegar ejemplo válido
                           </button>
                           <button
                             className="btn"
                             type="button"
                             onClick={() => handlePasteExternalMenuExample('invalid')}
                           >
                             Pegar ejemplo inválido
                           </button>
                         </div>

                         <div className="menu-import-example-grid">
                           <div className="menu-import-example-card">
                             <div className="menu-import-example-head">
                               <strong>Ejemplo de JSON válido</strong>
                               <span>Este formato sí lo podemos convertir en borrador.</span>
                             </div>
                             <pre className="menu-import-example-code">{EXTERNAL_AI_MENU_JSON_EXAMPLES.valid}</pre>
                           </div>
                           <div className="menu-import-example-card is-invalid">
                             <div className="menu-import-example-head">
                               <strong>Error común</strong>
                               <span>No pegues texto extra antes del JSON.</span>
                             </div>
                             <pre className="menu-import-example-code">{EXTERNAL_AI_MENU_JSON_EXAMPLES.invalid}</pre>
                           </div>
                         </div>

                         {validatedExternalMenu && (
                           <div className="menu-import-external-summary-wrap">
                             <div className="menu-import-external-summary">
                               <div>
                                 <strong>{validatedExternalMenu.menu_name}</strong>
                                 <span>Nombre detectado del menú</span>
                               </div>
                               <div>
                                 <strong>{validatedExternalMenu.summary.categoryCount}</strong>
                                 <span>categoría(s)</span>
                               </div>
                               <div>
                                 <strong>{validatedExternalMenu.summary.itemCount}</strong>
                                 <span>producto(s)</span>
                               </div>
                               <div>
                                 <strong>{validatedExternalMenu.summary.pricesPendingCount}</strong>
                                 <span>sin precio confirmado</span>
                               </div>
                               <div>
                                 <strong>{validatedExternalMenu.summary.hasNotes ? 'Sí' : 'No'}</strong>
                                 <span>incluye notes</span>
                               </div>
                               <div>
                                 <strong>{validatedExternalMenu.summary.noteCount}</strong>
                                 <span>nota(s)</span>
                               </div>
                             </div>

                             <div className="menu-import-category-preview">
                               <strong>Categorías detectadas</strong>
                               <div className="menu-import-category-preview-list">
                                 {validatedExternalMenu.summary.categoriesPreview.map((category) => (
                                   <span key={category.name} className="menu-import-category-chip">
                                     {category.name} · {category.itemCount}
                                   </span>
                                 ))}
                               </div>
                             </div>
                           </div>
                         )}

                         <div className="admin-card-actions">
                           <button className="btn" type="button" onClick={handleValidateExternalMenu}>
                             Validar JSON
                           </button>
                           <button className="btn btn-primary" type="button" onClick={handleConvertExternalMenuToDraft}>
                             <Save size={16} /> Convertir en borrador
                           </button>
                         </div>
                       </div>
                     </div>
                   ) : (
                     <div className="menu-import-entry-card">
                       <div>
                         <h3 className="admin-subsection-title">Crear menú manualmente</h3>
                         <p className="admin-copy">
                           Armá el menú desde cero dentro del panel. Después lo revisás y lo publicás con el mismo flujo actual.
                         </p>
                       </div>

                       <div className="menu-import-inline-note">
                         <strong>Qué incluye este modo</strong>
                         <span>
                           Nombre del menú, categorías, platos, descripción, precio y reordenamiento básico. No usa OCR ni revisión automática.
                         </span>
                       </div>

                       <div className="admin-card-actions">
                         <button className="btn btn-primary" type="button" onClick={handleCreateManualDraft}>
                           <Plus size={16} /> Crear menú manual
                         </button>
                       </div>
                     </div>
                   )}
                 </div>
             ) : (
                 <div>
                    <div className="admin-card-head admin-review-head">
                        <div>
                          <h3 className="admin-review-title">
                            {isManualDraft ? 'Editor manual del menú' : 'Revisión obligatoria del menú importado'}
                          </h3>
                          <p className="admin-copy">
                            {isManualDraft
                              ? 'Completá categorías, platos, descripciones y precios antes de publicar.'
                              : 'Revisá categorías, platos, descripciones y precios antes de publicar.'}
                          </p>
                        </div>
                        <div className="admin-card-actions">
                            <button className="btn" onClick={() => setParsedMenu(null)}>Descartar borrador <X size={16}/></button>
                            <button
                              className="btn"
                              onClick={addParsedCategory}
                            >
                              <Plus size={16}/> Agregar categoría
                            </button>
                            <button className="btn btn-primary" onClick={publishMenu} disabled={isPublishing || parsedMenu.categories.length === 0}>
                              {isPublishing ? 'Publicando...' : <><Save size={16}/> Guardar y Publicar en la App</>}
                            </button>
                        </div>
                    </div>

                    <div className={`menu-import-review-shell ${isManualDraft ? 'is-manual' : ''}`}>
                      <div className="menu-import-review-main">
                        <div className="menu-import-summary-card glass-panel">
                          <div className="menu-import-summary-head">
                            <div>
                              <h4 className="admin-meta-title">Nombre del menú</h4>
                              <p className="admin-copy">
                                {isManualDraft
                                  ? 'Este borrador se armó manualmente desde el panel admin.'
                                  : parsedMenu.diagnostics?.import_source === 'external_ai'
                                  ? 'Borrador generado desde JSON externo. Revisalo antes de publicarlo.'
                                  : 'Se publica como versión nueva y activa del menú.'}
                              </p>
                            </div>
                            {!isManualDraft && parsedMenu.confidence !== null && (
                              <div className="menu-review-confidence-pill">
                                <strong>{parsedMenu.confidence}</strong>
                                <span>Confianza global</span>
                              </div>
                            )}
                          </div>
                          <input
                            className="admin-input admin-input--compact"
                            value={parsedMenu.name}
                            onChange={(event) => updateDraftName(event.target.value)}
                          />
                        </div>

                        {parsedMenu.categories.map((cat, cIdx) => (
                          <div
                            key={`${cat.name}-${cIdx}`}
                            id={reviewCategoryDomId(cIdx)}
                            className={`menu-review-category glass-panel ${Number.parseInt(highlightedReviewTarget?.categoryIndex ?? '', 10) === cIdx ? 'is-highlighted' : ''} ${cat.reviewPriority > 0 ? 'needs-review' : ''}`}
                          >
                            <div className="menu-review-category-header">
                              <div className="menu-review-category-title">
                                <div className="menu-review-item-topline">
                                  <span className="admin-badge is-muted">Categoría {cIdx + 1}</span>
                                  {cat.confidence !== null && (
                                    <span className={`menu-review-quality-badge ${cat.confidence >= 85 ? 'is-high' : cat.confidence >= 70 ? 'is-medium' : 'is-low'}`}>
                                      Conf. {cat.confidence}
                                    </span>
                                  )}
                                  {cat.reviewCount > 0 && (
                                    <span className="menu-review-flag">
                                      {cat.reviewCount} {cat.reviewCount === 1 ? 'ítem a revisar' : 'ítems a revisar'}
                                    </span>
                                  )}
                                </div>
                                <input
                                  className="admin-input admin-input--compact"
                                  value={cat.name}
                                  onChange={e => updateParsedCat(cIdx, e.target.value)}
                                />
                                {cat.flags?.length > 0 && (
                                  <div className="menu-review-flag-list menu-review-flag-list--tight">
                                    {getCategoryFlagLabels(cat.flags).map((flag) => (
                                      <span key={`${flag}-${cIdx}`} className="menu-review-flag">
                                        {flag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {cat.reviewSummary?.length > 0 && (
                                  <div className="menu-review-summary-list">
                                    {cat.reviewSummary.map((summary) => (
                                      <span key={`${summary}-${cIdx}`} className="menu-review-summary-pill">
                                        {summary}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="menu-review-actions">
                                <button className="btn" onClick={() => moveParsedCategory(cIdx, -1)} disabled={cIdx === 0}>
                                  <ArrowUp size={16} />
                                </button>
                                <button className="btn" onClick={() => moveParsedCategory(cIdx, 1)} disabled={cIdx === parsedMenu.categories.length - 1}>
                                  <ArrowDown size={16} />
                                </button>
                                <button className="btn" onClick={() => addParsedItem(cIdx)}>
                                  <Plus size={16}/> Item
                                </button>
                                <button className="btn" onClick={() => removeParsedCategory(cIdx)}>
                                  <Trash2 size={16}/> Eliminar
                                </button>
                              </div>
                            </div>

                            <div className="menu-review-item-list">
                              {(cat.items || []).map((item, iIdx) => (
                                <div
                                  key={`${cIdx}-${iIdx}`}
                                  id={reviewItemDomId(cIdx, iIdx)}
                                  className={`menu-review-item ${Number.parseInt(highlightedReviewTarget?.categoryIndex ?? '', 10) === cIdx && Number.parseInt(highlightedReviewTarget?.itemIndex ?? '', 10) === iIdx ? 'is-highlighted' : ''}`}
                                >
                                  <div className="menu-review-item-top">
                                  <div className="menu-review-item-topline">
                                      <span className="admin-badge is-muted">Plato {iIdx + 1}</span>
                                      {item.confidence !== null && (
                                        <span className={`menu-review-quality-badge ${item.confidence >= 85 ? 'is-high' : item.confidence >= 70 ? 'is-medium' : 'is-low'}`}>
                                          Conf. {item.confidence}
                                        </span>
                                      )}
                                    </div>
                                    <div className="menu-review-actions">
                                      <button className="btn" onClick={() => moveParsedItem(cIdx, iIdx, -1)} disabled={iIdx === 0}>
                                        <ArrowUp size={16} />
                                      </button>
                                      <button className="btn" onClick={() => moveParsedItem(cIdx, iIdx, 1)} disabled={iIdx === cat.items.length - 1}>
                                        <ArrowDown size={16} />
                                      </button>
                                      <button className="btn" onClick={() => removeParsedItem(cIdx, iIdx)}>
                                        <Trash2 size={16}/> Eliminar
                                      </button>
                                    </div>
                                  </div>

                                  {item.flags?.length > 0 && (
                                    <div className="menu-review-flag-list">
                                      {getItemFlagLabels(item.flags).map((flag) => (
                                        <span key={`${flag}-${iIdx}`} className="menu-review-flag">
                                          {flag}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  <div className="menu-review-item-grid">
                                    <label>
                                      <span>Nombre</span>
                                      <input
                                        className="admin-input admin-input--compact"
                                        value={item.name}
                                        onChange={e => updateParsedItem(cIdx, iIdx, 'name', e.target.value)}
                                      />
                                    </label>
                                    <label>
                                      <span>Precio</span>
                                      <input
                                        className="admin-input admin-input--compact"
                                        value={item.price}
                                        type="number"
                                        step="0.01"
                                        onChange={e => updateParsedItem(cIdx, iIdx, 'price', e.target.value)}
                                      />
                                    </label>
                                  </div>

                                  <label className="admin-field">
                                    <span>Descripción</span>
                                    <textarea
                                      className="admin-input admin-input--textarea"
                                      value={item.description}
                                      onChange={e => updateParsedItem(cIdx, iIdx, 'description', e.target.value)}
                                    />
                                  </label>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {!isManualDraft && (
                      <aside className="menu-import-review-sidebar">
                        {previewImageSrc && (
                          <div className="menu-import-preview glass-panel">
                            {parsedMenu.previewImages.length > 0 && (
                              <div className="menu-import-preview-switcher">
                                {parsedMenu.previewImages.map((preview) => (
                                  <button
                                    key={preview.name}
                                    className={`menu-import-preview-tab ${previewMode === preview.name ? 'is-active' : ''}`}
                                    onClick={() => setPreviewMode(preview.name)}
                                    type="button"
                                  >
                                    {formatOcrVariantLabel(preview.name)}
                                  </button>
                                ))}
                              </div>
                            )}
                            <img src={previewImageSrc} alt="Menú subido para revisar" />
                            {parsedMenu.diagnostics?.ocr_variant && (
                              <div className="menu-import-preview-caption">
                                <strong>Preview activa:</strong> {formatOcrVariantLabel(previewMode)}
                                {previewMode === parsedMenu.diagnostics.ocr_variant ? ' · usada para OCR' : ''}
                              </div>
                            )}
                          </div>
                        )}

                        {parsedMenu.diagnostics && (
                          <div className="menu-import-meta glass-panel">
                            <h4 className="admin-meta-title">Lectura detectada</h4>
                            <div className="menu-import-meta-grid">
                              <div>
                                <strong>{parsedMenu.diagnostics.global_confidence ?? '--'}</strong>
                                <span>Conf. global</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.usable_line_count}</strong>
                                <span>Líneas útiles</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.discarded_count}</strong>
                                <span>Descartadas</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.suspicious_count ?? 0}</strong>
                                <span>Dudosas</span>
                              </div>
                              <div>
                                <strong>{reviewFocus?.items_to_review ?? 0}</strong>
                                <span>Items a revisar</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.section_count ?? '--'}</strong>
                                <span>Secciones</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.ocr_variant || 'original'}</strong>
                                <span>Variante OCR</span>
                              </div>
                              <div>
                                <strong>{parsedMenu.diagnostics.average_line_confidence ?? '--'}</strong>
                                <span>Conf. media</span>
                              </div>
                            </div>

                            {ocrCandidates.length > 0 && (
                              <div className="menu-import-candidate-list">
                                {ocrCandidates.map((candidate) => (
                                  <button
                                    key={candidate.name}
                                    type="button"
                                    className={`menu-import-candidate ${previewMode === candidate.name ? 'is-active' : ''}`}
                                    onClick={() => setPreviewMode(candidate.name)}
                                  >
                                    <div>
                                      <strong>{formatOcrVariantLabel(candidate.name)}</strong>
                                      <span>
                                        Score {candidate.score} · Conf. {candidate.average_line_confidence}
                                      </span>
                                    </div>
                                    {candidate.selected && <span className="admin-badge is-success">Usada</span>}
                                  </button>
                                ))}
                              </div>
                            )}

                            {(parsedMenu.diagnostics.preprocessing_steps || []).length > 0 && (
                              <div className="menu-review-flag-list menu-review-flag-list--spaced">
                                {parsedMenu.diagnostics.preprocessing_steps.map((step) => (
                                  <span key={step} className="menu-review-flag">
                                    {formatStepLabel(step)}
                                  </span>
                                ))}
                              </div>
                            )}

                            {reviewFocus && (
                              <div className="menu-review-flag-list menu-review-flag-list--spaced">
                                {reviewFocus.estimated_prices > 0 && (
                                  <span className="menu-review-flag">
                                    {reviewFocus.estimated_prices} precio(s) estimado(s)
                                  </span>
                                )}
                                {reviewFocus.low_confidence_items > 0 && (
                                  <span className="menu-review-flag">
                                    {reviewFocus.low_confidence_items} item(s) de baja confianza
                                  </span>
                                )}
                                {reviewFocus.inferred_categories > 0 && (
                                  <span className="menu-review-flag">
                                    {reviewFocus.inferred_categories} categoría(s) inferida(s)
                                  </span>
                                )}
                                {reviewFocus.service_notes > 0 && (
                                  <span className="menu-review-flag">
                                    {reviewFocus.service_notes} aclaración(es) general(es)
                                  </span>
                                )}
                              </div>
                            )}

                            {(parsedMenu.diagnostics.warnings || []).length > 0 && (
                              <div className="menu-import-warning-list">
                                {(parsedMenu.diagnostics.warnings || []).map((warning, index) => (
                                  <div key={`${warning}-${index}`} className="menu-import-warning-item">
                                    {warning}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {parsedMenu.notes?.length > 0 && (
                          <div className="menu-import-meta glass-panel">
                            <h4 className="admin-meta-title is-tight">Notas importadas</h4>
                            <div className="menu-import-warning-list">
                              {parsedMenu.notes.map((note, index) => (
                                <div key={`${note}-${index}`} className="menu-import-warning-item">
                                  {note}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {reviewQueue.length > 0 && (
                          <div className="menu-import-meta glass-panel">
                            <h4 className="admin-meta-title is-tight">Conviene revisar primero</h4>
                            <div className="menu-import-priority-list">
                              {reviewQueue.map((category) => (
                                <div key={`${category.name}-${category.review_priority}`} className="menu-import-priority-item">
                                  <div>
                                    <strong>{category.name}</strong>
                                    <span>
                                      {category.review_count > 0
                                        ? `${category.review_count} item(s) con flags`
                                        : 'Revisión sugerida'}
                                    </span>
                                  </div>
                                  <div className="menu-review-summary-list">
                                    {(category.summary || []).map((summary) => (
                                      <span key={`${category.name}-${summary}`} className="menu-review-summary-pill">
                                        {summary}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="menu-import-meta glass-panel">
                          <h4 className="admin-meta-title">Progreso de revisión</h4>
                          <div className="menu-import-progress-grid">
                            <div>
                              <strong>{pendingReviewCount}</strong>
                              <span>Pendientes</span>
                            </div>
                            <div>
                              <strong>{reviewStats.rescued}</strong>
                              <span>Rescatadas</span>
                            </div>
                            <div>
                              <strong>{reviewStats.ignored}</strong>
                              <span>Ignoradas</span>
                            </div>
                          </div>
                          <p className="menu-import-progress-helper">
                            {pendingReviewCount > 0
                              ? 'Enter aplica la acción sugerida de la línea activa. Escape la ignora.'
                              : 'No quedan líneas pendientes. El borrador está listo para una revisión final.'}
                          </p>
                        </div>

                        {parsedMenu.suspiciousLines.length > 0 && (
                          <div className="menu-import-meta glass-panel">
                            <h4 className="admin-meta-title is-tight">Líneas dudosas para revisar</h4>
                            <div className="menu-import-discarded-list">
                              {parsedMenu.suspiciousLines.map((line, index) => renderReviewLineCard(line, index, 'suspicious'))}
                            </div>
                          </div>
                        )}

                        {discardedReviewLines.length > 0 && (
                          <div className="menu-import-meta glass-panel">
                            <h4 className="admin-meta-title is-tight">Texto descartado como ruido</h4>
                            <div className="menu-import-discarded-list">
                              {discardedReviewLines.map((line, index) => renderReviewLineCard(line, index, 'discarded'))}
                            </div>
                          </div>
                        )}
                      </aside>
                      )}
                    </div>
                 </div>
             )}
          </div>
      )}

      {activeTab === 'venue_settings' && (
        <section className="glass-panel settings-panel">
          <div className="settings-panel-header">
            <div>
              <h2 className="admin-section-title">Configuración básica del local</h2>
              <p className="admin-section-copy">
                Actualizá la identidad visible y los links operativos básicos sin tocar el deploy.
              </p>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              onClick={saveVenueSettings}
              disabled={isSavingSettings}
            >
              {isSavingSettings ? 'Guardando...' : <><Save size={16} /> Guardar cambios</>}
            </button>
          </div>

          {settingsFeedback && (
            <div className={`settings-feedback ${settingsFeedbackType === 'error' ? 'settings-feedback-error' : 'settings-feedback-success'}`}>
              {settingsFeedback}
            </div>
          )}

          <div className="settings-grid">
            <label className="settings-field">
              <span>Nombre del local</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.restaurant_name}
                onChange={(event) => updateSettingsField('restaurant_name', event.target.value)}
              />
              {settingsErrors.restaurant_name && <small className="settings-error">{settingsErrors.restaurant_name}</small>}
            </label>

            <label className="settings-field settings-field-wide">
              <span>Subtítulo</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.restaurant_subtitle}
                onChange={(event) => updateSettingsField('restaurant_subtitle', event.target.value)}
              />
            </label>

            <label className="settings-field">
              <span>Etiqueta de contacto</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.contact_label}
                onChange={(event) => updateSettingsField('contact_label', event.target.value)}
              />
            </label>

            <label className="settings-field">
              <span>URL de contacto</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.contact_url}
                onChange={(event) => updateSettingsField('contact_url', event.target.value)}
                placeholder="wa.me/549..."
              />
              {(settingsErrors.contact_url || settingsErrors.contact) && (
                <small className="settings-error">{settingsErrors.contact_url || settingsErrors.contact}</small>
              )}
            </label>

            <label className="settings-field">
              <span>Link de reseñas</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.review_url}
                onChange={(event) => updateSettingsField('review_url', event.target.value)}
                placeholder="google.com/maps"
              />
              {settingsErrors.review_url && <small className="settings-error">{settingsErrors.review_url}</small>}
            </label>

            <label className="settings-field">
              <span>Link de sugerencias</span>
              <input
                className="admin-input admin-input--compact"
                value={settingsForm.feedback_url}
                onChange={(event) => updateSettingsField('feedback_url', event.target.value)}
                placeholder="forms.gle/..."
              />
              {settingsErrors.feedback_url && <small className="settings-error">{settingsErrors.feedback_url}</small>}
            </label>
          </div>
        </section>
      )}

      {showAddTableModal && (
        <div className="modal-overlay" onClick={() => !isCreatingTable && setShowAddTableModal(false)}>
          <div
            className="modal-content glass-panel admin-modal admin-modal--tables"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header admin-modal-head">
              <div>
                <h3 className="admin-modal-title">Mesas y QR</h3>
                <p className="admin-copy">
                  Creá mesas nuevas, revisá sus QRs y exportalos para imprimir o guardar como PDF.
                </p>
              </div>
              <button className="close-btn" type="button" onClick={() => setShowAddTableModal(false)} disabled={isCreatingTable}>
                <X size={20} />
              </button>
            </div>

            <form className="admin-modal-form" onSubmit={handleCreateTable}>
              <div className="admin-table-modal-head">
                <label className="admin-field">
                  <span>Número de mesa</span>
                  <input
                    className="admin-input admin-input--compact"
                    type="number"
                    min="1"
                    step="1"
                    value={newTableId}
                    onChange={(event) => setNewTableId(event.target.value)}
                    placeholder="Ej. 12"
                  />
                </label>

                <div className="admin-card-actions">
                  <button className="btn" type="button" onClick={() => printTableCards(tables)} disabled={!tables.length}>
                    <Printer size={16} /> Imprimir / PDF
                  </button>
                  <button className="btn btn-primary" type="submit" disabled={isCreatingTable || !String(newTableId).trim()}>
                    {isCreatingTable ? 'Creando mesa...' : <><Plus size={16} /> Crear mesa y QR</>}
                  </button>
                </div>
              </div>

              <p className="admin-copy admin-modal-note">
                El número se usa en el QR y en el seguimiento de pedidos y solicitudes de esa mesa.
              </p>
            </form>

            {tablesActionError && (
              <div className="admin-alert is-error is-compact">
                <strong className="admin-alert-title">{tablesActionErrorTitle}</strong>
                <span className="admin-alert-copy">{tablesActionError}</span>
              </div>
            )}

            {tablesActionSuccess && (
              <div className="admin-alert is-success is-compact">
                <strong className="admin-alert-title">{tablesActionSuccessTitle}</strong>
                <span className="admin-alert-copy">{tablesActionSuccess}</span>
              </div>
            )}

            {tablesStatus === 'loading' && <div className="loader"></div>}

            {tablesStatus === 'error' && (
              <div className="status-card status-card-error admin-status-card">
                <div>
                  <strong>No pudimos cargar las mesas.</strong>
                  <span>{tablesError}</span>
                </div>
              </div>
            )}

            {tablesStatus === 'empty' && (
              <div className="glass-panel admin-empty-state">
                <h2>Todavía no hay mesas cargadas.</h2>
                <p>Creá la primera mesa para generar su QR y dejarlo listo para imprimir.</p>
              </div>
            )}

            {tables.length > 0 && (
              <div className="admin-table-grid">
                {tables.map((table) => (
                  <article key={table.id} className="admin-table-card">
                    <div className="admin-table-card-head">
                      <div className="admin-table-card-copy">
                        <span className={`admin-badge ${getTableBadgeClass(table.id)}`}>Mesa {table.id}</span>
                        <strong>{table.label || `QR listo para Mesa ${table.id}`}</strong>
                      </div>
                      <QrCode size={18} />
                    </div>

                    <div className="admin-table-qr">
                      <img src={table.qr_image} alt={`QR de Mesa ${table.id}`} />
                    </div>

                    <a className="admin-table-link" href={table.url} target="_blank" rel="noreferrer">
                      {table.url}
                    </a>

                    <div className="admin-card-actions">
                      <button className="btn" type="button" onClick={() => window.open(table.url, '_blank', 'noopener,noreferrer')}>
                        <ExternalLink size={16} /> Abrir mesa
                      </button>
                      <button className="btn" type="button" onClick={() => printTableCards([table])}>
                        <Printer size={16} /> Imprimir QR
                      </button>
                      <button
                        className="btn admin-outline-action is-danger"
                        type="button"
                        onClick={() => handleDeleteTable(table.id)}
                        disabled={deletingTableId === table.id}
                      >
                        <Trash2 size={16} /> {deletingTableId === table.id ? 'Eliminando...' : 'Eliminar mesa'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className="admin-modal-actions">
              <button className="btn" type="button" onClick={() => setShowAddTableModal(false)} disabled={isCreatingTable}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearMenuConfirm && (
        <div className="modal-overlay" onClick={() => setShowClearMenuConfirm(false)}>
          <div
            className="modal-content glass-panel admin-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header admin-modal-head">
              <div>
                <h3 className="admin-modal-title">¿Vaciar el menú publicado?</h3>
                <p className="admin-copy">
                  Los clientes dejarán de ver el menú actual hasta que publiques uno nuevo.
                </p>
                <p className="admin-copy admin-modal-note">
                  Esta acción no elimina pedidos ni historial.
                </p>
              </div>
              <button className="close-btn" type="button" onClick={() => setShowClearMenuConfirm(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="admin-modal-actions">
              <button className="btn" type="button" onClick={() => setShowClearMenuConfirm(false)} disabled={isClearingMenu}>
                Cancelar
              </button>
              <button className="btn btn-primary" type="button" onClick={clearActiveMenu} disabled={isClearingMenu}>
                {isClearingMenu ? 'Vaciando menú...' : 'Sí, vaciar menú'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
