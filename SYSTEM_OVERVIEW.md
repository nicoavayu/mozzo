# Mozzo - Resumen funcional y técnico

## 1. Qué es Mozzo

Mozzo es una app de restaurante orientada a salón. El producto tiene dos superficies:

- cliente por mesa, accesible por URL o QR
- panel admin para operación del local

Hoy cubre:

- publicación de menú versionado
- constructor manual de menú
- importación de menú por foto e IA externa
- disponibilidad por producto
- pedido por mesa con un solo pedido abierto a la vez
- lifecycle operativo del pedido
- solicitud y entrega de cuenta
- pagos manuales múltiples por pedido
- split payment por monto
- caja / apertura / cierre / arqueo simple
- cierre explícito de mesa
- historial operativo de pedidos cerrados
- configuración básica del local

Hoy no cubre:

- pagos online
- reversos o anulación de pagos
- split bill por persona o por item
- caja avanzada / cierre de turno / arqueo ciego
- multi-sucursal
- roles finos

## 2. Superficies del producto

### Cliente por mesa

Ruta:

- `/:tableId`

Responsabilidades:

- ver menú activo
- armar draft local
- confirmar pedido
- seguir estado realtime
- pedir mozo
- pedir / cancelar cuenta mientras no haya sido entregada
- ver total, pagado y saldo del pedido activo
- ver links del local desde `venueSettings`

Archivos principales:

- [frontend/src/App.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/App.jsx)
- [frontend/src/hooks/useTableSession.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/hooks/useTableSession.js)
- [frontend/src/components/table/TableMenuPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableMenuPage.jsx)
- [frontend/src/components/table/TableDashboardPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableDashboardPage.jsx)
- [frontend/src/components/table/TableOrderPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableOrderPage.jsx)

### Admin

Ruta:

- `/admin`

Responsabilidades:

- ver tablero operativo realtime
- cambiar estados del pedido
- gestionar solicitudes de salón
- importar / construir / publicar menú
- cambiar disponibilidad por producto
- registrar pagos
- cerrar mesas
- abrir y cerrar caja
- ver historial operativo
- editar venue settings

Archivo principal:

- [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)

## 3. Modelo de dominio actualizado

### Pedido

El pedido sigue siendo la unidad operativa principal de una mesa.

Un pedido se considera abierto mientras:

- `closed_at IS NULL`

Estados operativos:

- `pending`
- `processing`
- `ready`
- `delivered`

Estados de pago derivados:

- `unpaid`
- `partial`
- `paid`

Campos operativos relevantes:

- `created_at`
- `processing_started_at`
- `ready_at`
- `delivered_at`
- `bill_requested_at`
- `bill_attended_at`
- `closed_at`

Campos financieros derivados en API:

- `total_amount`
- `amount_paid`
- `amount_due`
- `payment_status`
- `can_close`
- `payments`
- `payments_summary`

### Pago

El pago ya no vive conceptualmente dentro de `orders` como un único evento.

Ahora la fuente de verdad para pagos nuevos es:

- `order_payments`

Un pedido puede tener:

- `0..N` pagos

Split payment, en esta versión, significa:

- múltiples pagos por monto sobre el mismo pedido
- con uno o varios métodos

No significa:

- dividir items por comensal
- dividir fiscalmente la cuenta

### Caja

La caja se modela como una sesión operativa:

- abierta
- luego cerrada

Cada pago nuevo puede quedar asociado a una sesión de caja.

Reglas importantes:

- solo puede haber una caja abierta a la vez
- pagos `cash` requieren caja abierta
- pagos no cash pueden registrarse sin caja abierta
- si hay caja abierta, pagos no cash también quedan asociados a esa sesión por trazabilidad

## 4. Lifecycle actualizado del pedido

Flujo completo:

1. la mesa arma y confirma pedido
2. el pedido entra como `pending`
3. admin lo lleva a `processing`
4. luego a `ready`
5. luego a `delivered`
6. la mesa pide cuenta
7. admin entrega cuenta
8. admin registra uno o varios pagos
9. cuando el saldo llega a cero, admin puede cerrar la mesa
10. recién ahí se define `closed_at`
11. el pedido entra al historial

### Diferencia entre estado operativo, pago y cierre

- estado operativo:
  - describe producción / servicio
  - termina en `delivered`
- estado de pago:
  - deriva de `total_amount` vs pagos registrados
  - puede ser `unpaid`, `partial`, `paid`
- cierre:
  - depende solo de `closed_at`
  - es una acción explícita separada

### Reglas clave

- registrar pago no cierra la mesa
- cerrar la mesa requiere:
  - pedido existente
  - pedido no cerrado
  - estado `delivered`
  - cuenta entregada
  - saldo pendiente `<= 0`
- historial usa `closed_at`, no `payment_received_at`

## 5. Pagos y split payment

Métodos soportados:

- `cash`
- `card`
- `transfer`
- `other`

Cálculos:

- `total_amount`: suma de snapshots en `order_items`
- `amount_paid`: suma de pagos efectivos del pedido
- `amount_due`: `total_amount - amount_paid`, redondeado
- `payment_status`:
  - `unpaid` si no hay pagos efectivos
  - `partial` si hay pagos pero queda saldo
  - `paid` si el saldo quedó en cero

Reglas:

- no se permiten pagos `<= 0`
- no se permite sobrepago
- no se permite pagar pedido cerrado
- no se permite pagar pedido no entregado
- no se permite pagar antes de entregar la cuenta
- no se permite un pago cash sin caja abierta

Campo `payment_method` en responses de orden:

- si todos los pagos efectivos usan el mismo método, devuelve ese método
- si hay mezcla de métodos, devuelve `split`
- si no hay pagos, puede ser `null`

Campo `payment_received_at` en responses de orden:

- se considera el momento en que la orden quedó totalmente saldada
- para legacy, puede venir del campo histórico en `orders`

## 6. Caja / arqueo

Una caja es una sesión operativa guardada en `cash_register_sessions`.

Campos principales:

- `status`
- `opened_at`
- `closed_at`
- `opening_float`
- `expected_cash_amount`
- `counted_cash_amount`
- `cash_difference`

Semántica:

- `opening_float`: fondo inicial
- `expected_cash_amount`: `opening_float + pagos cash asociados`
- `counted_cash_amount`: efectivo contado por el local al cerrar
- `cash_difference`: `counted - expected`

Importante:

- `expected_cash_amount` solo refleja efectivo
- el resumen de caja también muestra pagos no cash, pero no suman al esperado cash

## 7. Historial operativo

Un pedido entra al historial cuando:

- `closed_at IS NOT NULL`

El historial:

- se filtra por `closed_at`
- no mezcla pedidos abiertos
- muestra total, pagado, saldo, método derivado y tiempos

Compatibilidad:

- pedidos viejos sin `order_payments` siguen apareciendo
- si solo tienen `payment_received_at` / `payment_method`, el backend sintetiza un pago legacy
- si hay mezcla legacy + nuevos, el backend sintetiza solo el remanente necesario para mantener consistencia histórica

## 8. Venue settings

La identidad visible del local se lee desde:

- `venue_settings`

Campos actuales:

- `restaurant_name`
- `restaurant_subtitle`
- `contact_label`
- `contact_url`
- `review_url`
- `feedback_url`

Frontend actual:

- cliente y admin leen la misma fuente de verdad
- el evento realtime es `venue_settings_updated`

## 9. Realtime relevante

Eventos principales:

- `new_order`
- `order_confirmed`
- `order_updated`
- `table_request_created`
- `table_request_updated`
- `menu_updated`
- `venue_settings_updated`
- `cash_register_updated`

Uso principal:

- `order_updated` refresca lifecycle, pagos, saldo y cierre
- `cash_register_updated` refresca estado de caja en admin
- `menu_updated` refresca menú/disponibilidad
- `venue_settings_updated` refresca datos visibles del local

## 10. Mapa del código

Backend:

- [backend/server.js](/Users/nicoavayu/Downloads/Mozzo/backend/server.js)
  - define endpoints HTTP y eventos Socket.IO
- [backend/database.js](/Users/nicoavayu/Downloads/Mozzo/backend/database.js)
  - conexión SQLite y helper transaccional serializado
- [backend/lib/orders.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/orders.js)
  - dominio de pedidos, saldos, cierre e historial
- [backend/lib/order-payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/order-payments.js)
  - creación y resumen de pagos
- [backend/lib/cash-register.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/cash-register.js)
  - apertura, cierre y resumen de caja
- [backend/lib/menu-store.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/menu-store.js)
  - publicación y disponibilidad de menú
- [backend/lib/venue-settings.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/venue-settings.js)
  - lectura y guardado de identidad del local

Frontend:

- [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)
  - tablero, historial, caja, menú, settings
- [frontend/src/hooks/useTableSession.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/hooks/useTableSession.js)
  - estado cliente por mesa
- [frontend/src/lib/adminPayments.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/lib/adminPayments.js)
  - validaciones defensivas de pagos y caja en admin
- [frontend/src/lib/orderHistory.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/lib/orderHistory.js)
  - filtros y labels del historial

Migraciones y tests:

- [backend/migrations/011_add_cash_register_and_order_payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/011_add_cash_register_and_order_payments.js)
- [backend/scripts/smoke.js](/Users/nicoavayu/Downloads/Mozzo/backend/scripts/smoke.js)
- [backend/scripts/test-sprint7.js](/Users/nicoavayu/Downloads/Mozzo/backend/scripts/test-sprint7.js)

## 11. Limitaciones actuales

- no hay refunds ni anulación de pagos
- no hay edición o borrado de pagos registrados
- no hay split bill por persona o por item
- no hay múltiples cajas activas por local
- no hay multi-sucursal
- no hay identidad real de usuario staff en pagos/caja, solo campos preparados
- el breakdown histórico por método es por pedido derivado, no por distribución exacta de payment rows
- la timezone del historial sigue dependiendo del proceso Node

## 12. Próximos pasos sugeridos

1. pasarela real de pagos con idempotencia sobre el modelo nuevo
2. estrategia de deprecación de endpoints legacy de pago
3. refunds / voids
4. staff real en `created_by` / `opened_by` / `closed_by`
5. timezone explícita de reporting
