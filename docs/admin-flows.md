# Guía operativa para admin

## 1. Tablero realtime

La tab principal muestra solo pedidos abiertos.

Columnas operativas:

- `Pendientes`
- `En preparación`
- `Listos`
- `Pedidos entregados y cierre económico`

Un pedido desaparece del tablero solo cuando:

- se cierra la mesa
- es decir, cuando `closed_at` queda seteado

## 2. Flujo operativo recomendado

### Paso 1. Abrir caja

Antes de cobrar en efectivo:

1. entrar a tab `Caja`
2. cargar fondo inicial
3. abrir caja

Si no abrís caja:

- los pagos `cash` fallan
- los pagos no cash pueden seguir registrándose

### Paso 2. Operar pedidos abiertos

En el tablero:

1. `Pendiente -> Preparar`
2. `En preparación -> Listo`
3. `Listo -> Entregado`

Eso actualiza el estado operativo del pedido.

### Paso 3. Atender solicitudes de salón

En `Solicitudes de salón` podés ver:

- `Llamar al mozo`
- `Pedir la cuenta`

Si resolvés una solicitud de cuenta:

- el pedido pasa a tener `bill_attended_at`
- desde ese momento ya se puede cobrar

### Paso 4. Registrar pagos

En un pedido entregado con cuenta entregada:

- cargás monto
- elegís método
- opcionalmente una nota
- apretás `Registrar pago`

Qué muestra el tablero:

- `Total`
- `Pagado`
- `Saldo`
- `Estado de pago`
- lista de pagos ya cargados

### Paso 5. Cerrar mesa

Solo cuando el saldo llega a cero aparece habilitado:

- `Cerrar mesa`

Importante:

- registrar pago **no** cierra la mesa
- cerrar mesa es una acción explícita aparte

### Paso 6. Revisar historial

En la tab `Historial` se ven:

- pedidos cerrados
- total cobrado
- ticket promedio
- tiempos
- breakdown por medio de pago

El historial usa:

- `closed_at`

No muestra pedidos abiertos aunque estén pagados.

### Paso 7. Cerrar caja

Al finalizar:

1. ir a `Caja`
2. revisar `Esperado cash`
3. cargar `Efectivo contado`
4. cerrar caja

El sistema muestra:

- diferencia positiva o negativa

## 3. Qué significan los estados visibles

### Estados del pedido

- `Pendiente`
- `En preparación`
- `Listo`
- `Entregado`

### Estados de pago

- `Sin pagar`
- `Pago parcial`
- `Pagado`

### Estados de caja

- `Abierta`
- `Cerrada`

## 4. Errores comunes y cómo interpretarlos

### “La cuenta todavía no fue entregada”

Significa:

- intentaste cobrar antes de resolver la solicitud de cuenta

### “Abrí una caja antes de registrar pagos en efectivo”

Significa:

- el medio elegido es `cash`
- no hay caja abierta

### “El monto supera el saldo pendiente”

Significa:

- intentaste sobrepagar la orden

### “Todavía queda un saldo pendiente”

Significa:

- intentaste cerrar la mesa antes de saldarla

### “Ya hay una caja abierta”

Significa:

- intentaste abrir otra caja sin cerrar la actual

## 5. Qué ve el admin en la sección financiera del pedido

Por pedido entregado:

- total
- pagado
- saldo
- estado de pago
- pagos individuales
- método derivado:
  - uno solo si todos coinciden
  - `Pago dividido` si hay mezcla

## 6. Reglas importantes para operación diaria

- una mesa puede tener un solo pedido abierto
- no cierres una mesa sin saldo cero
- si el pago es cash, abrí caja primero
- un pedido pagado puede seguir abierto hasta que alguien lo cierre
- el historial solo refleja mesas cerradas

## 7. Qué no está soportado todavía

- devolver un pago
- editar un pago existente
- borrar pagos
- dividir la cuenta por persona o por items
- cerrar varias cajas simultáneas

## 8. Archivos clave para entender lo que ve el admin

- [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)
- [frontend/src/lib/adminPayments.js](/Users/nicoavayu/Downloads/Mozzo/frontend/src/lib/adminPayments.js)
- [backend/lib/orders.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/orders.js)
- [backend/lib/cash-register.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/cash-register.js)
