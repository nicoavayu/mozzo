# Backend API relevante

## Convenciones generales

- Auth admin: `Authorization: Bearer <token>`
- Cliente por mesa no usa auth admin
- La mayoría de errores de dominio responden:

```json
{
  "error": "Mensaje legible",
  "code": "CODIGO_DE_ERROR"
}
```

En algunos casos también se devuelve metadata útil:

```json
{
  "error": "Todavía queda un saldo pendiente de 28.00.",
  "code": "ORDER_BALANCE_PENDING",
  "amount_due": 28
}
```

## Shape resumido de una orden en API

Las respuestas de orden relevantes hoy incluyen:

- `id`
- `table_id`
- `status`
- `items`
- `total_amount`
- `amount_paid`
- `amount_due`
- `payment_status`
- `payment_method`
- `payment_received_at`
- `payments`
- `payments_summary`
- `can_close`
- timestamps operativos y `closed_at`

`payment_method` y `payment_received_at` en responses son campos derivados/compatibles.  
La fuente de verdad nueva para pagos es `order_payments`.

## Auth admin

### `POST /api/admin/login`

Uso:

- login del panel admin

Body:

```json
{ "password": "..." }
```

Respuesta:

```json
{
  "token": "jwt",
  "expires_at": 1234567890
}
```

## Venue settings

### `GET /api/venue-settings`

Uso:

- cliente
- admin

Qué hace:

- devuelve settings del local con fallback resuelto

### `PUT /api/admin/venue-settings`

Uso:

- admin

Body:

```json
{
  "restaurant_name": "Mozzo Palermo",
  "restaurant_subtitle": "Cocina y barra",
  "contact_label": "WhatsApp",
  "contact_url": "https://wa.me/54911...",
  "review_url": "https://maps.google.com/...",
  "feedback_url": "https://forms.gle/..."
}
```

Errores frecuentes:

- nombre vacío
- URL inválida
- `contact_label` sin `contact_url` o viceversa

## Menú

### `GET /api/menu`

Uso:

- cliente
- admin

Qué hace:

- devuelve categorías e items del menú activo

Incluye por item:

- `id`
- `name`
- `description`
- `price`
- `is_available`

### `GET /api/menu/active`

Uso:

- admin

Qué hace:

- devuelve resumen del menú activo publicado

### `POST /api/menu/upload`

Uso:

- admin

Qué hace:

- procesa una imagen de menú
- devuelve borrador estructurado para revisión/publicación

### `POST /api/menu/publish`

Uso:

- admin

Qué hace:

- publica una nueva versión de menú

Reglas:

- ningún item puede publicarse sin precio válido
- ningún precio vacío se convierte a `0`

Errores frecuentes:

- `INVALID_MENU_PRICE`
- `INVALID_MENU_ITEM`
- `EMPTY_MENU_PUBLISH`

### `DELETE /api/menu/active`

Uso:

- admin

Qué hace:

- despublica el menú activo

### `PATCH /api/admin/menu-items/:id/availability`

Uso:

- admin

Qué hace:

- prende/apaga disponibilidad de un item del menú activo

## Pedidos de cliente y estado de mesa

### `POST /api/orders`

Uso:

- cliente por mesa
- socket `place_order`

Qué hace:

- crea un pedido abierto

Reglas:

- una sola orden abierta por mesa
- items deben existir en el menú activo
- no se pueden pedir items no disponibles

### `GET /api/tables/:id/orders/session`

Uso:

- cliente por mesa

Qué hace:

- devuelve:
  - `active_order`
  - `latest_order`

Es la lectura principal del estado de mesa.

### `GET /api/tables/:id/orders/active`

Uso:

- compatibilidad / debug

Qué hace:

- devuelve solo la orden activa de la mesa

## Solicitudes de salón

### `GET /api/tables/:id/requests/active`

Uso:

- cliente por mesa

### `POST /api/tables/:id/call-waiter`

### `DELETE /api/tables/:id/call-waiter`

### `POST /api/tables/:id/request-bill`

Qué hace:

- marca `bill_requested_at`
- crea `table_request` tipo `request_bill`

### `DELETE /api/tables/:id/request-bill`

Qué hace:

- cancela la solicitud de cuenta si todavía no fue entregada

Errores frecuentes:

- `NO_OPEN_ORDER`
- `BILL_ALREADY_ATTENDED`

### `GET /api/table-requests`

Uso:

- admin

### `POST /api/table-requests/:id/resolve`

Uso:

- admin

Qué hace:

- resuelve una solicitud de salón
- si es `request_bill`, además marca `bill_attended_at`

## Pedidos abiertos e historial admin

### `GET /api/admin/orders/open`

Uso:

- tablero realtime del admin

Qué hace:

- devuelve solo órdenes abiertas (`closed_at IS NULL`)

Este es el endpoint correcto para el kanban vivo.

### `GET /api/admin/orders/history`

Uso:

- tab `Historial` del admin

Qué hace:

- devuelve pedidos cerrados (`closed_at IS NOT NULL`)

Filtros:

- `preset=today|last_7_days`
- `from`
- `to`
- `payment_method`
- `limit`
- `offset`

Notas:

- el período se aplica por `closed_at`
- `payment_method=split` filtra pedidos con métodos mezclados a nivel orden derivada

### `GET /api/admin/orders/history/summary`

Uso:

- cards de resumen del historial

Qué devuelve:

- `orders_count`
- `total_revenue`
- `average_ticket`
- `average_prep_minutes`
- `average_service_minutes`
- `average_to_payment_minutes`
- `payment_breakdown`

## Pagos

### `GET /api/admin/orders/:id/payments`

Uso:

- admin

Qué hace:

- devuelve resumen financiero y lista de pagos del pedido

Respuesta resumida:

```json
{
  "order_id": 12,
  "total_amount": 48,
  "amount_paid": 20,
  "amount_due": 28,
  "payment_status": "partial",
  "payments_summary": { "...": "..." },
  "payments": [ ... ]
}
```

### `POST /api/admin/orders/:id/payments`

Uso:

- admin

Qué hace:

- registra un nuevo pago sobre la orden

Body:

```json
{
  "amount": 20,
  "method": "cash",
  "note": "Primera parte"
}
```

Reglas:

- pedido debe existir
- no debe estar cerrado
- debe estar `delivered`
- la cuenta debe haber sido entregada
- monto válido
- no puede ser `<= 0`
- no puede redondear a `0.00`
- en la práctica, el mínimo efectivo aceptado es `0.01`
- no puede exceder el saldo pendiente
- cash requiere caja abierta

Errores frecuentes:

- `ORDER_NOT_FOUND`
- `ORDER_ALREADY_CLOSED`
- `ORDER_NOT_DELIVERED`
- `BILL_NOT_ATTENDED`
- `INVALID_PAYMENT_AMOUNT`
- `INVALID_PAYMENT_METHOD`
- `INVALID_PAYMENT_NOTE`
- `PAYMENT_OVERFLOW`
- `ORDER_ALREADY_PAID`
- `OPEN_CASH_REGISTER_REQUIRED`

## Cierre explícito

### `POST /api/admin/orders/:id/close`

Uso:

- admin

Qué hace:

- cierra explícitamente la orden
- resuelve solicitudes pendientes de esa mesa

Reglas:

- pedido debe existir
- no debe estar cerrado
- debe estar `delivered`
- la cuenta debe haber sido entregada
- `amount_due <= 0`

Errores frecuentes:

- `ORDER_NOT_FOUND`
- `ORDER_ALREADY_CLOSED`
- `ORDER_NOT_DELIVERED`
- `BILL_NOT_ATTENDED`
- `ORDER_BALANCE_PENDING`

## Caja

### `GET /api/admin/cash-register/current`

Uso:

- admin

Qué hace:

- devuelve la caja abierta actual o `null`

### `POST /api/admin/cash-register/open`

Body:

```json
{
  "opening_float": 100,
  "notes_open": "Turno noche"
}
```

Reglas:

- solo una caja abierta a la vez
- `opening_float >= 0`

Errores frecuentes:

- `CASH_REGISTER_ALREADY_OPEN`
- `INVALID_CASH_REGISTER_AMOUNT`
- `INVALID_CASH_REGISTER_TEXT`

### `POST /api/admin/cash-register/current/close`

Body:

```json
{
  "counted_cash_amount": 119,
  "notes_close": "Cierre test"
}
```

Qué hace:

- cierra la caja abierta
- calcula:
  - `expected_cash_amount`
  - `counted_cash_amount`
  - `cash_difference`

Errores frecuentes:

- `NO_OPEN_CASH_REGISTER`
- `INVALID_CASH_REGISTER_AMOUNT`
- `INVALID_CASH_REGISTER_TEXT`

### `GET /api/admin/cash-register/history`

Uso:

- admin

Qué hace:

- devuelve sesiones de caja recientes

### `GET /api/admin/cash-register/:id`

Uso:

- admin

Qué hace:

- devuelve una sesión puntual con su summary

## Mesas admin

### `GET /api/admin/tables`

Uso:

- admin

Qué hace:

- devuelve mesas con payload listo para operar/imprimir
- incluye `url` pública y `qr_image`

### `POST /api/admin/tables`

Uso:

- admin

Qué hace:

- crea una mesa nueva y devuelve su payload QR

### `DELETE /api/admin/tables/:id`

Uso:

- administración de mesas y QR

### `GET /api/tables/:id/qr`

Uso:

- admin
- utilitario / compatibilidad

Qué hace:

- devuelve QR puntual para una mesa
- response:
  - `tableId`
  - `url`
  - `qrImage`

## Endpoints legacy / compatibilidad

### `GET /api/orders`

Qué hace:

- devuelve todas las órdenes

Estado:

- sigue expuesto
- no es el endpoint recomendado para tablero operativo nuevo

### `POST /api/tables/:id/payment`

Qué hace hoy:

- registra el saldo restante de la orden activa de la mesa
- usa el modelo nuevo de pagos
- **ya no cierra la mesa**

Estado:

- compatibilidad legacy
- no es el endpoint recomendado para el admin nuevo

### `POST /api/tables/:id/close`

Qué hace:

- cierra la orden abierta de la mesa

Estado:

- sigue vigente como helper por mesa
- el admin nuevo usa `POST /api/admin/orders/:id/close`

### `GET /api/guest-links`

Estado:

- legado
- el cliente actual ya consume `venueSettings`
- no conviene usarlo en código nuevo
