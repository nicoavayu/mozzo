# Pagos, split payment y cierre de mesa

## 1. Objetivo del modelo actual

La versión actual separa explícitamente:

- el estado operativo del pedido
- el estado de pago del pedido
- el cierre de la mesa

Esto reemplaza la regla vieja donde cobrar cerraba la mesa en la misma operación.

## 2. Qué significa cada concepto

### Pedido abierto

Un pedido está abierto mientras:

- `closed_at IS NULL`

Que un pedido esté abierto no implica nada sobre su saldo.  
Puede estar:

- sin pagar
- parcialmente pagado
- completamente pagado

### Pedido saldado

Un pedido está saldado cuando:

- `amount_due <= 0`
- `payment_status === 'paid'`

Esto no significa que ya esté cerrado.

### Pedido cerrado

Un pedido está cerrado cuando:

- `closed_at` tiene valor

`closed_at` sigue siendo la fuente de verdad para:

- cierre de mesa
- salida del tablero operativo
- entrada al historial

## 3. Modelo de pagos

### Fuente de verdad

Para pedidos nuevos, la fuente de verdad es:

- `order_payments`

Cada fila registra:

- monto
- método
- nota opcional
- fecha
- caja asociada si aplica

### Métodos soportados

- `cash`
- `card`
- `transfer`
- `other`

### Split payment

En Mozzo, split payment significa:

- varios pagos sobre el mismo pedido
- con uno o varios métodos

Ejemplo:

- pedido total `1000`
- pago 1: `400 cash`
- pago 2: `600 card`

Resultado:

- `amount_paid = 1000`
- `amount_due = 0`
- `payment_status = paid`
- `payment_method = split`

## 4. Cálculo de montos

### `total_amount`

Se calcula desde snapshots en `order_items`:

- `quantity * unit_price`

Esto evita depender del menú actual publicado.

### `amount_paid`

Se calcula sumando pagos efectivos del pedido:

- pagos nuevos en `order_payments`
- o pagos legacy sintetizados si no existen filas nuevas

### `amount_due`

Se calcula como:

- `total_amount - amount_paid`

Regla:

- si la diferencia queda dentro de una tolerancia pequeña, se considera `0`

### `payment_status`

- `unpaid`: no hay pagos efectivos
- `partial`: hay pagos, pero queda saldo
- `paid`: saldo en cero

## 5. Reglas de negocio de pagos

Reglas implementadas:

- no se permiten montos `<= 0`
- no se permite monto que redondee a `0.00`
- no se permite sobrepago
- no se permite pagar un pedido inexistente
- no se permite pagar un pedido cerrado
- no se permite pagar si el pedido no fue entregado
- no se permite pagar si la cuenta todavía no fue entregada
- pagos cash requieren caja abierta
- pagos no cash pueden registrarse aunque no haya caja abierta

## 6. Flujo operativo actual

1. pedido en `delivered`
2. la mesa pide cuenta
3. el salón entrega cuenta
4. admin registra uno o más pagos
5. cuando el saldo queda en cero, el pedido queda saldado
6. admin ejecuta `Cerrar mesa`
7. recién ahí se define `closed_at`

## 7. Cierre explícito

Registrar pago:

- no cierra la mesa
- no saca la orden del tablero
- solo actualiza saldo y estado de pago

Cerrar mesa:

- es una acción aparte
- requiere saldo cero
- resuelve solicitudes pendientes de la mesa
- emite `order_updated`

## 8. Comportamiento del admin

En pedidos entregados el admin ve:

- total
- pagado
- saldo
- estado de pago
- lista de pagos cargados
- form para registrar pago
- botón `Cerrar mesa` solo si `can_close === true`

El admin tiene dos acciones distintas:

- `Registrar pago`
- `Cerrar mesa`

Esa separación es intencional y es parte central del modelo nuevo.

## 9. Compatibilidad legacy

Los campos históricos en `orders` siguen existiendo:

- `payment_received_at`
- `payment_method`

Se consideran legacy/compatibilidad.

### Cómo funciona la compatibilidad

Caso 1:

- pedido histórico cerrado
- sin filas en `order_payments`
- con `payment_received_at`

Resultado:

- el backend sintetiza un pago legacy por el total

Caso 2:

- pedido con marca legacy de pago
- además con uno o más pagos nuevos

Resultado:

- el backend usa los pagos nuevos
- si todavía falta parte del total, sintetiza solo el remanente legacy

Esto evita:

- dejar pedidos cerrados como `partial`
- duplicar el total completo legacy encima de pagos nuevos

## 10. Qué no soporta todavía

- refunds
- voids
- edición o borrado de pagos
- split bill por item
- múltiples pagos vinculados a un mismo evento externo
- propina o descuentos complejos

## 11. Casos especiales documentados

### Pedido total `0`

Si un pedido tiene total `0` y cumple:

- `status === delivered`
- `bill_attended_at` existe

puede cerrarse sin pagos.

### Pedido ya saldado

No acepta más pagos.

### Pedido ya cerrado

No acepta pagos ni segundo cierre.

### Cierre con saldo pendiente

Devuelve:

- `409 ORDER_BALANCE_PENDING`
- `amount_due`

## 12. Deuda técnica conocida

- `payment_method` top-level en historial es derivado por pedido, no por distribución exacta de payment rows
- el endpoint legacy `POST /api/tables/:id/payment` sigue existiendo por compatibilidad
- la limpieza total de campos legacy todavía no conviene mientras haya pedidos viejos en producción
