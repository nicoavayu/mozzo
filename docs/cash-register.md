# Caja y arqueo simple

## 1. Qué modela la caja

Mozzo modela caja como una sesión operativa:

- se abre
- recibe pagos asociados
- se cierra con arqueo

La entidad es:

- `cash_register_sessions`

## 2. Campos principales

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

## 3. Regla principal

Solo puede haber:

- una caja abierta a la vez

Esto está reforzado por:

- validación de dominio
- índice único parcial en SQLite

## 4. Apertura de caja

Al abrir caja se registra:

- fondo inicial
- nota opcional
- usuario/rol de apertura si existe

Validaciones:

- `opening_float >= 0`
- no puede haber otra caja abierta

## 5. Asociación entre pagos y caja

### Pagos cash

Regla:

- requieren caja abierta

Si no hay caja abierta:

- el backend rechaza el pago con `OPEN_CASH_REGISTER_REQUIRED`

### Pagos no cash

Regla:

- pueden registrarse sin caja abierta

Si hay caja abierta:

- quedan asociados también a esa sesión por trazabilidad

Si no hay caja abierta:

- se guardan con `cash_register_session_id = null`

## 6. Qué significa `expected_cash_amount`

Fórmula actual:

- `opening_float + suma de pagos cash asociados a la sesión`

Importante:

- tarjeta, transferencia y otros no afectan `expected_cash_amount`
- sí aparecen en el summary general de la sesión

## 7. Cierre de caja

Cerrar caja requiere:

- una caja abierta
- monto contado real

Al cerrar se calculan:

- `expected_cash_amount`
- `counted_cash_amount`
- `cash_difference`

Fórmula:

- `cash_difference = counted_cash_amount - expected_cash_amount`

Ejemplos:

- esperado `120`, contado `119` -> diferencia `-1`
- esperado `120`, contado `125` -> diferencia `+5`

## 8. Endpoints de caja

### `GET /api/admin/cash-register/current`

Devuelve:

- sesión abierta actual o `null`

### `POST /api/admin/cash-register/open`

Body:

```json
{
  "opening_float": 100,
  "notes_open": "Turno noche"
}
```

### `POST /api/admin/cash-register/current/close`

Body:

```json
{
  "counted_cash_amount": 119,
  "notes_close": "Cierre"
}
```

### `GET /api/admin/cash-register/history`

Devuelve:

- sesiones recientes con resumen

### `GET /api/admin/cash-register/:id`

Devuelve:

- una sesión puntual con su breakdown

## 9. Qué ve el admin

En la tab `Caja` el admin puede:

1. abrir caja
2. ver la caja actual
3. ver:
   - fondo inicial
   - esperado cash
   - total cobrado
   - breakdown por método
4. cerrar caja con efectivo contado
5. ver historial de cajas recientes

## 10. Errores comunes

### `CASH_REGISTER_ALREADY_OPEN`

Significa:

- ya hay una caja abierta

### `NO_OPEN_CASH_REGISTER`

Significa:

- intentaron cerrar caja sin una caja abierta

### `INVALID_CASH_REGISTER_AMOUNT`

Significa:

- monto vacío, inválido o negativo en apertura/cierre

### `OPEN_CASH_REGISTER_REQUIRED`

Significa:

- intentaron registrar un pago cash sin caja abierta

## 11. Relación con el historial de pedidos

Caja y cierre de mesa no son lo mismo.

Un pedido:

- puede quedar totalmente pagado
- seguir abierto
- luego cerrarse

La caja registra pagos.  
El historial operativo usa `closed_at`.

## 12. Limitaciones actuales

- una sola caja global, sin multi-sucursal
- no hay reapertura de caja
- no hay arqueo ciego
- no hay retiro/ingreso manual de efectivo fuera de pagos
- no hay conciliación bancaria
- no hay permisos finos por cajero

## 13. Código clave

- [backend/lib/cash-register.js](/Users/nicoavayu/Downloads/Mozzo/backend/lib/cash-register.js)
- [backend/migrations/011_add_cash_register_and_order_payments.js](/Users/nicoavayu/Downloads/Mozzo/backend/migrations/011_add_cash_register_and_order_payments.js)
- [backend/server.js](/Users/nicoavayu/Downloads/Mozzo/backend/server.js)
- [frontend/src/components/AdminPanel.jsx](/Users/nicoavayu/Downloads/Mozzo/frontend/src/components/AdminPanel.jsx)
