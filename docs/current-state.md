# Estado actual de Mozzo

Snapshot funcional y técnico del estado real del sistema hoy.

## 1. Qué es Mozzo hoy

Mozzo es una app de restaurante orientada a salón con dos superficies:

- cliente por mesa, accesible por URL o QR
- panel admin para operar salón, cobro, caja, menú e historial

El cliente está pensado principalmente para mobile.  
El admin es el tablero operativo del local.

## 2. Qué ya funciona

- menú versionado
- importación de menú por foto
- importación asistida por IA externa
- constructor manual de menú
- disponibilidad por producto
- una sola cuenta abierta por mesa
- múltiples subpedidos dentro de la misma cuenta
- cola operativa por subpedido y por hora real de llegada
- seguimiento realtime de pedidos y solicitudes
- llamar al mozo
- pedir la cuenta con elección de método
- cobro manual en efectivo
- cobro manual con tarjeta
- cobro online con Mercado Pago
- múltiples pagos por pedido
- reversals manuales append-only
- caja / arqueo simple
- cierre explícito de mesa
- historial operativo de pedidos cerrados
- configuración básica del local
- gestión de mesas y QR
- sonidos operativos en admin para pedido / mozo / cuenta

## 3. Qué no cubre todavía

- refunds reales contra la API de Mercado Pago
- split bill por persona o por item
- anulación o edición destructiva de pagos
- múltiples cajas simultáneas por local
- multi-sucursal real
- permisos finos por usuario staff
- arqueo avanzado o caja ciega
- cancelación operativa completa de subpedidos desde la UI

## 4. Modelo de dominio actual

### Cuenta de mesa

La entidad raíz sigue siendo `orders`.

En la versión actual, `orders` representa:

- la cuenta abierta de una mesa
- el total consolidado a cobrar
- la fuente de verdad del cierre mediante `closed_at`

Regla:

- sigue habiendo una sola cuenta abierta por mesa

### Subpedidos

La operación de cocina/salón ya no vive solo en `orders`.

Ahora existe:

- `order_suborders`
- `order_suborder_items`

Cada subpedido tiene:

- `id`
- `order_id`
- `table_id`
- `sequence_number`
- `status`
- timestamps propios
- items snapshot propios

Esto permite que una mesa:

- haga un primer pedido
- más tarde agregue otro envío
- y ese adicional entre a la cola por su `created_at` real

### Snapshot agregado

`order_items` sigue existiendo como snapshot agregado de la cuenta.

Cuando se crea un subpedido nuevo:

- sus items se guardan en `order_suborder_items`
- y también se agregan a `order_items`

Eso preserva sin reescritura:

- totales
- pagos
- historial
- reporting actual

## 5. Cómo funciona el flujo principal

### Flujo de mesa

1. la mesa entra por QR/URL
2. ve el menú activo
3. agrega productos al draft local
4. confirma el primer pedido
5. si todavía no pidió la cuenta, puede seguir agregando subpedidos
6. cada subpedido nuevo entra como envío adicional dentro de la misma cuenta
7. cuando termina, pide la cuenta
8. elige cómo quiere pagar
9. el pago real puede ser manual o por Mercado Pago
10. aunque el saldo llegue a cero, la mesa no se cierra sola
11. admin cierra la mesa explícitamente
12. recién ahí entra al historial

### Flujo operativo

Cada subpedido tiene estados propios:

- `pending`
- `processing`
- `ready`
- `delivered`
- `cancelled`

La cola operativa del admin usa subpedidos, no la cuenta raíz.

La prioridad real es:

- por `created_at` del subpedido

### Estado agregado de la cuenta

`orders.status` sigue existiendo, pero ahora es derivado del conjunto de subpedidos no cancelados.

Regla actual:

- si hay algún subpedido `pending` -> `orders.status = pending`
- si no hay `pending` pero hay `processing` -> `processing`
- si no hay `pending/processing` pero hay `ready` -> `ready`
- si todos están `delivered` o `cancelled` -> `delivered`

## 6. Pedidos adicionales / subpedidos

Hoy ya está soportado que una mesa agregue más cosas después del primer pedido.

Ejemplo:

- mesa pide comida
- más tarde agrega postre o café

Comportamiento:

- el adicional entra como subpedido nuevo
- no hereda prioridad del primero
- aparece separado en la cola operativa
- pero se cobra dentro de la misma cuenta

Restricción v1:

- si `bill_requested_at` ya existe, no se permiten nuevos subpedidos

## 7. Pedido de cuenta y método elegido

`Pedir la cuenta` ya no es solo un aviso genérico.

Ahora inicia el flujo de cobro.

Métodos soportados:

- `cash`
- `card`
- `mercado_pago`

Esto distingue tres cosas:

1. solicitud de cuenta
2. método preferido elegido por la mesa
3. pago real registrado

### Si la mesa elige efectivo

- la orden queda esperando cobro presencial
- admin lo ve como flujo manual
- el pago real se registra luego como `cash`

### Si la mesa elige tarjeta

- la orden queda esperando cobro con terminal/posnet
- admin lo ve como flujo manual
- el pago real se registra luego como `card`

### Si la mesa elige Mercado Pago

- se dispara el checkout online
- si queda `approved + applied`, recién ahí se crea un `order_payment`
- si falla o queda en otro estado, no toca el ledger

### Cambio de método

El método elegido no bloquea el pago real.

Si la mesa eligió Mercado Pago pero termina pagando manual:

- se puede registrar pago cash o card normalmente
- el intento online queda auditado
- no se duplica el cobro

## 8. Pagos internos

La fuente de verdad de pagos aplicados es:

- `order_payments`

Características:

- append-only
- múltiples pagos por cuenta
- split payment por monto
- métodos soportados:
  - `cash`
  - `card`
  - `transfer`
  - `other`
  - `mercado_pago`

Campos derivados importantes por orden:

- `total_amount`
- `amount_paid`
- `amount_due`
- `payment_status`

Estados de pago:

- `unpaid`
- `partial`
- `paid`

Reglas:

- no se permiten montos `<= 0`
- no se permite sobrepago
- no se permite pagar una orden cerrada
- no se permite pagar antes de `delivered`
- no se permite pagar antes de `bill_attended_at`
- pagos cash requieren caja abierta

## 9. Reversals manuales

Ya existe reversión manual append-only.

La tabla es:

- `order_payment_reversals`

Reglas:

- no se borran pagos
- no se muta destructivamente el pago original
- la reversión queda auditada
- requiere motivo
- registra actor y fecha
- recalcula saldo neto

Hoy los reversals:

- funcionan para pagos internos
- funcionan también sobre pagos creados desde Mercado Pago ya aplicados al ledger
- no disparan refund real contra Mercado Pago

## 10. Mercado Pago

Mercado Pago ya está integrado con checkout externo separado del ledger interno.

Modelo:

- `mercado_pago_checkouts`

La integración actual separa:

- estado externo (`status`)
- disposición interna (`sync_disposition`)

Estados externos contemplados:

- `pending`
- `approved`
- `rejected`
- `cancelled`
- `expired`
- `failed`
- `refunded`
- `charged_back`
- `reversed`

Disposición interna:

- `pending`
- `applied`
- `ignored`
- `stale`
- `mismatched`

Regla clave:

- solo `approved + applied` crea un `order_payment`

El resto:

- queda auditado
- no toca el ledger

Además:

- webhook y return son idempotentes
- `payment_id` externo no puede impactar dos veces
- si un checkout viejo llega tarde, queda auditado como `stale` o `mismatched`

## 11. Caja y arqueo

La caja actual es simple pero ya operativa.

Tabla:

- `cash_register_sessions`

Flujo:

1. abrir caja
2. registrar pagos asociados
3. cerrar caja con contado real
4. guardar diferencia

Reglas:

- solo una caja abierta a la vez
- cash requiere caja abierta
- no cash puede registrarse sin caja abierta
- si hay caja abierta, pagos no cash también pueden asociarse por trazabilidad

Campos principales:

- `opening_float`
- `expected_cash_amount`
- `counted_cash_amount`
- `cash_difference`

## 12. Cierre de mesa

La mesa no se cierra por pagar.

Eso quedó separado a propósito.

Reglas:

- registrar pago no cierra
- cerrar mesa es una acción aparte
- solo se puede cerrar con saldo cero
- `closed_at` sigue siendo la fuente de verdad del cierre

## 13. Historial

El historial operativo sigue entrando por:

- `closed_at IS NOT NULL`

Eso significa:

- una orden pagada pero no cerrada no entra todavía al historial
- una cuenta cerrada sí entra, con su resumen completo

El historial hoy entiende:

- pagos internos nuevos
- reversals
- compatibilidad legacy
- intentos externos de Mercado Pago como auditoría separada

## 14. Compatibilidad legacy

Mozzo sigue conviviendo con campos históricos en `orders`:

- `payment_received_at`
- `payment_method`

La compatibilidad está pensada para que:

- pedidos viejos sigan apareciendo bien
- no queden con saldo incorrecto
- no se rompan reportes

El flujo nuevo igual usa como fuente de verdad:

- `order_payments`
- `order_payment_reversals`
- `mercado_pago_checkouts`

## 15. Qué ve el cliente hoy

La experiencia cliente es mobile-first.

### Home de la mesa

La home está más limpia y contiene solo acciones relevantes:

- llamar al mozo
- pedir la cuenta
- ver accesos del local si existen
- feedback/review cuando corresponde

No muestra navegación redundante si no hace falta.

### Menú

La vista de menú hoy permite:

- explorar categorías
- abrir búsqueda solo cuando se la necesita
- agregar productos al draft
- seguir navegando mientras arma el pedido
- ver una barra inferior compacta con resumen del draft

### Mi pedido

La vista `Mi pedido` hoy muestra:

- la cuenta abierta
- envíos / subpedidos agrupados
- estado de cada envío
- total, pagado y saldo
- elección de pago si ya pidió la cuenta

### Estado visible del pedido

Arriba a la derecha puede aparecer un badge vivo:

- `En curso`
- `Listo`
- `En camino`

Además hay feedback de confirmación cuando el pedido entra a cocina.

## 16. Qué ve el admin hoy

El admin concentra:

- cola operativa por subpedido
- cuentas abiertas por mesa
- cobro manual
- caja
- historial
- menú
- mesas y QR
- settings del local

### Operación

Ve subpedidos separados y ordenados por llegada real.

### Cobro

Ve la cuenta raíz por mesa con:

- total
- pagado
- saldo
- pagos internos
- reversals
- intentos online auditados

### Sonidos

El admin ya tiene sonidos para:

- pedido nuevo
- llamar al mozo
- pedir la cuenta

## 17. Realtime

Eventos relevantes hoy:

- `new_order`
- `order_confirmed`
- `order_updated`
- `suborder_created`
- `suborder_updated`
- `table_request_created`
- `table_request_updated`
- `menu_updated`
- `venue_settings_updated`
- `cash_register_updated`

Uso real:

- el cliente se refresca con cambios de pedido y solicitudes
- el admin se refresca con pedidos, subpedidos, caja y requests

## 18. Reglas operativas más importantes

- una sola cuenta abierta por mesa
- muchos subpedidos dentro de esa cuenta
- no se permiten subpedidos después de pedir la cuenta
- el cobro vive en la cuenta raíz
- el cierre vive en la cuenta raíz
- el estado operativo real vive en subpedidos
- `orders.status` es agregado
- pagar no cierra
- cerrar exige saldo cero
- cash exige caja abierta
- Mercado Pago no toca el ledger salvo `approved + applied`

## 19. Estado de testing actual

Backend:

- smoke
- sprint5
- sprint6
- sprint7
- sprint8
- sprint9
- sprint10
- sprint11
- sprint12
- payments QA
- hardening

Frontend:

- check
- sprint7
- sprint8
- sprint9
- sprint11
- sprint12
- order-status
- admin-sounds

## 20. Limitaciones vigentes

- faltan pruebas reales end-to-end con Mercado Pago productivo
- refunds reales contra MP todavía no existen
- el flujo de subpedidos todavía tiene deuda de UX fina
- falta cancelación explícita de subpedidos desde UI
- los usuarios internos todavía no son identidades de staff completas
- hay documentación vieja del repo que todavía puede mencionar el modelo anterior

## 21. Dónde conviene mirar primero en código

Cliente:

- [frontend/src/hooks/useTableSession.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/hooks/useTableSession.js)
- [frontend/src/components/table/TableDashboardPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableDashboardPage.jsx)
- [frontend/src/components/table/TableMenuPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableMenuPage.jsx)
- [frontend/src/components/table/TableOrderPage.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/table/TableOrderPage.jsx)

Admin:

- [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)
- [frontend/src/lib/adminSoundAlerts.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/lib/adminSoundAlerts.js)

Backend:

- [backend/server.js](/Users/nicoavayu/Downloads/Mozzo/backend/server.js)
- [backend/lib/orders.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/orders.js)
- [backend/lib/order-suborders.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/order-suborders.js)
- [backend/lib/order-payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/order-payments.js)
- [backend/lib/cash-register.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/cash-register.js)
- [backend/lib/mercado-pago.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/mercado-pago.js)
- [backend/lib/table-requests.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/table-requests.js)

Migraciones relevantes:

- [backend/migrations/011_add_cash_register_and_order_payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/011_add_cash_register_and_order_payments.js)
- [backend/migrations/012_add_mercado_pago_checkout_sessions.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/012_add_mercado_pago_checkout_sessions.js)
- [backend/migrations/013_add_order_payment_reversals.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/013_add_order_payment_reversals.js)
- [backend/migrations/014_harden_mercado_pago_checkout_states.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/014_harden_mercado_pago_checkout_states.js)
- [backend/migrations/015_add_bill_payment_flow_fields.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/015_add_bill_payment_flow_fields.js)
- [backend/migrations/016_create_order_suborders.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/016_create_order_suborders.js)

## 22. Resumen corto de dónde estamos parados

Mozzo ya no es solo un MVP de pedido por mesa.

Hoy ya tiene:

- cuenta por mesa
- subpedidos reales
- operación realtime
- cobro manual y online
- ledger append-only
- reversals append-only
- caja simple
- cierre explícito
- historial usable

Lo que sigue más natural desde acá es:

- estabilizar UX fina del cliente
- validar Mercado Pago con tráfico real
- seguir endureciendo operación de salón
- ordenar la documentación vieja alrededor de este modelo nuevo
