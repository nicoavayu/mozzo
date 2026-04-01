# Arquitectura, modelo de datos y mapa del código

## 1. Arquitectura general

Mozzo está dividido en dos capas principales:

- frontend React + Vite + Socket.IO client
- backend Node + Express + Socket.IO + SQLite

Superficies:

- cliente por mesa
- panel admin

Patrón general:

- el backend expone HTTP para lectura/escritura
- Socket.IO se usa para propagar cambios operativos
- SQLite guarda el estado de negocio y las migraciones del sistema

## 2. Principios de dominio de la versión actual

### Pedido

El pedido sigue siendo la unidad central de operación.

Responsabilidades:

- agrupar items de una mesa
- reflejar estado operativo del servicio
- reflejar estado de cuenta
- mantener referencia al cierre real vía `closed_at`

### Pago

El pago está separado del pedido como entidad explícita.

Fuente de verdad nueva:

- `order_payments`

Consecuencia:

- un pedido puede tener varios pagos
- el pago ya no implica cierre automático
- el cierre depende del saldo y de una acción aparte

### Caja

La caja se modela como sesión operativa:

- apertura
- asociación de pagos
- cierre con arqueo

Fuente de verdad:

- `cash_register_sessions`

### Cierre

La mesa se considera cerrada solo cuando:

- `orders.closed_at` tiene valor

Esto separa tres conceptos distintos:

- estado operativo del pedido
- estado de pago
- estado de cierre

## 3. Modelo de datos relevante

## `orders`

Propósito:

- representar el pedido principal de una mesa

Campos principales:

- `id`
- `table_id`
- `status`
- `created_at`
- `processing_started_at`
- `ready_at`
- `delivered_at`
- `bill_requested_at`
- `bill_attended_at`
- `payment_received_at` legacy
- `payment_method` legacy
- `closed_at`

Relaciones:

- `orders.id -> order_items.order_id`
- `orders.id -> order_payments.order_id`

Observaciones:

- `payment_received_at` y `payment_method` siguen existiendo por compatibilidad histórica
- el flujo nuevo no usa esos campos como fuente de verdad de pagos
- una orden abierta es una orden con `closed_at IS NULL`

## `order_items`

Propósito:

- snapshot del contenido del pedido en el momento de confirmación

Campos principales:

- `id`
- `order_id`
- `item_id`
- `quantity`
- `comments`
- `item_name`
- `item_description`
- `unit_price`

Observaciones:

- el total de una orden se calcula desde `quantity * unit_price`
- esto desacopla historial y pagos del menú activo actual

## `order_payments`

Propósito:

- registrar pagos explícitos sobre un pedido

Campos principales:

- `id`
- `order_id`
- `cash_register_session_id`
- `amount`
- `method`
- `note`
- `created_at`
- `created_by`

Relaciones:

- `order_payments.order_id -> orders.id`
- `order_payments.cash_register_session_id -> cash_register_sessions.id`

Observaciones:

- es la fuente de verdad nueva para pagos
- soporta split payment por monto
- no soporta refunds ni edición de pagos

## `cash_register_sessions`

Propósito:

- registrar sesiones de caja y su arqueo simple

Campos principales:

- `id`
- `status`
- `opened_at`
- `closed_at`
- `opening_float`
- `expected_cash_amount`
- `counted_cash_amount`
- `cash_difference`
- `notes_open`
- `notes_close`
- `opened_by`
- `closed_by`
- `venue_id`

Observaciones:

- solo puede haber una caja abierta a la vez
- `expected_cash_amount` persiste al cerrar
- mientras la caja está abierta, el expected live se deriva del fondo inicial y pagos cash asociados

## `venue_settings`

Propósito:

- guardar la identidad visible y links operativos del local

Campos principales:

- `id = 1`
- `restaurant_name`
- `restaurant_subtitle`
- `contact_label`
- `contact_url`
- `review_url`
- `feedback_url`
- `updated_at`

Observaciones:

- hay una sola fila lógica
- el frontend usa esta tabla como fuente de verdad de settings

## Otras tablas relevantes

### `tables`

- inventario simple de mesas y QR

### `table_requests`

- solicitudes de salón como `call_waiter` y `request_bill`

### `menus`, `menu_categories`, `menu_items`

- modelo del menú versionado publicado

## 4. Estados y transiciones

### Estado operativo del pedido

- `pending`
- `processing`
- `ready`
- `delivered`

### Estado de pago derivado

- `unpaid`
- `partial`
- `paid`

### Estado de cierre

- abierto: `closed_at IS NULL`
- cerrado: `closed_at IS NOT NULL`

### Reglas de transición relevantes

- no se puede pagar antes de `delivered`
- no se puede pagar antes de `bill_attended_at`
- pagar no cierra
- cerrar exige saldo cero
- historial entra por `closed_at`

## 5. Cálculos derivados importantes

## `total_amount`

- suma de `order_items.quantity * order_items.unit_price`

## `amount_paid`

- suma de pagos efectivos del pedido
- incluye `order_payments`
- puede incluir pago legacy sintetizado si la orden vieja no tiene filas nuevas

## `amount_due`

- `total_amount - amount_paid`
- se redondea y usa tolerancia chica para considerar cero

## `payment_status`

- `unpaid` si no hay pagos efectivos
- `partial` si hay pagos y queda saldo
- `paid` si el saldo quedó en cero

## `payment_method`

Campo derivado a nivel orden:

- un método único si todos los pagos coinciden
- `split` si hay mezcla
- `null` si todavía no hay pagos

## 6. Compatibilidad legacy

La compatibilidad vieja/nueva está centralizada principalmente en:

- [backend/lib/order-payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/order-payments.js)

Qué se considera legacy:

- `orders.payment_received_at`
- `orders.payment_method`

Cómo se interpreta:

- si una orden vieja tiene marca legacy de pago y no tiene `order_payments`, se sintetiza un pago por el total
- si una orden tiene pagos nuevos y además marca legacy, se sintetiza solo el remanente necesario

Qué evita esto:

- órdenes históricas cerradas apareciendo con saldo
- doble conteo bruto entre modelo nuevo y viejo

Qué no conviene hacer:

- leer `orders.payment_method` como fuente principal para código nuevo
- escribir lógica financiera nueva fuera de `order-payments.js`

## 7. Realtime y refresco de UI

Eventos relevantes:

- `new_order`
- `order_confirmed`
- `order_updated`
- `table_request_created`
- `table_request_updated`
- `menu_updated`
- `venue_settings_updated`
- `cash_register_updated`

Superficies que reaccionan:

- cliente por mesa:
  - `order_confirmed`
  - `order_updated`
  - `table_request_*`
  - `menu_updated`
- admin:
  - `new_order`
  - `order_updated`
  - `table_request_*`
  - `menu_updated`
  - `cash_register_updated`
- `App.jsx`:
  - `venue_settings_updated`

Importante:

- el admin además hace refetch puntual de historial/caja en acciones sensibles
- no depende solo del socket para quedar consistente

## 8. Mapa del código

## Backend

### [backend/server.js](/Users/nicoavayu/Downloads/Mozzo/backend/server.js)

Responsabilidad:

- wiring HTTP
- wiring Socket.IO
- traducción de errores de dominio a HTTP

Cuándo tocarlo:

- al agregar endpoints
- al agregar nuevos eventos
- al ajustar contratos API

Qué no conviene romper:

- shape consistente de errores
- emisiones de `order_updated`, `menu_updated`, `cash_register_updated`

### [backend/database.js](/Users/nicoavayu/Downloads/Mozzo/backend/database.js)

Responsabilidad:

- conexión SQLite
- migraciones
- helper transaccional serializado

Cuándo tocarlo:

- cambios de bootstrap DB
- cambios de path/config DB
- cambios de concurrencia transaccional

Qué no conviene romper:

- serialización de transacciones
- path estable fuera del repo

### [backend/lib/orders.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/orders.js)

Responsabilidad:

- lifecycle de órdenes
- listados abiertos/historial
- cálculo derivado de orden
- cierre explícito

Cuándo tocarlo:

- cambios en dominio del pedido
- cambios en history/open orders
- cambios en reglas de cierre

Qué no conviene romper:

- separación pago vs cierre
- `closed_at` como verdad del historial

### [backend/lib/order-payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/order-payments.js)

Responsabilidad:

- validación de pagos
- creación de pagos
- resumen financiero
- bridge legacy

Cuándo tocarlo:

- cambios de split payment
- cambios de compatibilidad legacy
- futuras integraciones de pasarela

Qué no conviene romper:

- `summarizeOrderPayments()`
- `getEffectivePaymentsForOrder()`

### [backend/lib/cash-register.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/cash-register.js)

Responsabilidad:

- apertura
- caja actual
- cierre
- summary / history de caja

Cuándo tocarlo:

- nuevas reglas de arqueo
- nuevas restricciones de caja

Qué no conviene romper:

- unicidad de caja abierta
- expected cash basado solo en pagos cash

## Frontend

### [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)

Responsabilidad:

- tablero realtime
- pagos
- cierre de mesa
- historial
- caja
- venue settings
- menú/admin

Cuándo tocarlo:

- cambios operativos visibles del admin
- nuevos tabs o acciones

Qué no conviene romper:

- separación entre `Registrar pago` y `Cerrar mesa`
- fetch de órdenes abiertas separado del historial

### [frontend/src/hooks/useTableSession.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/hooks/useTableSession.js)

Responsabilidad:

- estado del cliente por mesa
- sync con menú, pedido y solicitudes
- reacción a realtime

Cuándo tocarlo:

- cambios de lifecycle cliente
- cambios en request bill / cancelación

Qué no conviene romper:

- una sola fuente de verdad para venue settings
- reconciliación de draft con menú y pedido activo

### [frontend/src/lib/adminPayments.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/lib/adminPayments.js)

Responsabilidad:

- validaciones defensivas de pago y caja en UI admin

Cuándo tocarlo:

- cambios de reglas de negocio de pagos o caja

Qué no conviene romper:

- que la UI bloquee acciones inválidas antes de pegarle al backend

## Tests y smoke

### [backend/scripts/smoke.js](/Users/nicoavayu/Downloads/Mozzo/backend/scripts/smoke.js)

- flujo feliz integrado del sistema

### [backend/scripts/test-sprint7.js](/Users/nicoavayu/Downloads/Mozzo/backend/scripts/test-sprint7.js)

- edge cases de caja, pagos y cierre separado

### [backend/scripts/test-hardening.js](/Users/nicoavayu/Downloads/Mozzo/backend/scripts/test-hardening.js)

- cruces críticos de operación y consistencia

### [frontend/scripts/test-sprint7.js](/Users/nicoavayu/Downloads/Mozzo/frontend/scripts/test-sprint7.js)

- validaciones críticas del admin financiero

## 9. Decisiones de negocio que no conviene asumir distinto

- registrar pago no implica cierre
- historial entra por `closed_at`
- una orden pagada puede seguir abierta
- cash sin caja abierta se rechaza
- no se permite sobrepago
- split payment es por monto, no por item ni por comensal

## 10. Limitaciones técnicas vigentes

- no hay refunds ni voids
- no hay edición o borrado de pagos
- no hay múltiples cajas por venue
- no hay timezone del local explícita para reporting
- siguen existiendo endpoints legacy por compatibilidad
- `created_by` / `opened_by` / `closed_by` no representan todavía un staff real autenticado
