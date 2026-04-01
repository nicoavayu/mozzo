# Mozzo

Mozzo es una app de restaurante orientada a salón con dos superficies principales:

- cliente por mesa, accesible por URL/QR
- panel admin para operación del local

La base actual cubre:

- menú versionado
- importación de menú por foto, IA externa y constructor manual
- disponibilidad por producto
- un pedido abierto por mesa
- lifecycle operativo del pedido
- solicitud y entrega de cuenta
- múltiples pagos por pedido
- split payment por monto
- caja / arqueo simple
- cierre explícito de mesa
- historial operativo de pedidos cerrados
- configuración básica del local

No cubre todavía:

- pasarela de pago real
- reversos o refunds
- split bill por comensal o por item
- multi-sucursal
- roles finos de staff
- arqueo avanzado o caja ciega

## Documentación

Punto de entrada recomendado:

- [SYSTEM_OVERVIEW.md](/Users/nicoavayu/Downloads/Mozzo/SYSTEM_OVERVIEW.md)

Detalle por tema:

- [docs/current-state.md](/Users/nicoavayu/Downloads/Mozzo/docs/current-state.md)
- [docs/architecture.md](/Users/nicoavayu/Downloads/Mozzo/docs/architecture.md)
- [docs/backend-api.md](/Users/nicoavayu/Downloads/Mozzo/docs/backend-api.md)
- [docs/payments-and-closing.md](/Users/nicoavayu/Downloads/Mozzo/docs/payments-and-closing.md)
- [docs/cash-register.md](/Users/nicoavayu/Downloads/Mozzo/docs/cash-register.md)
- [docs/admin-flows.md](/Users/nicoavayu/Downloads/Mozzo/docs/admin-flows.md)

## Stack

- frontend: React + Vite + Socket.IO
- backend: Node + Express + Socket.IO + SQLite

## Setup rápido

```bash
nvm use
npm run setup
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run db:migrate
npm run db:seed
npm run dev
```

Abrir:

- cliente: `http://localhost:5173/:tableId`
- admin: `http://localhost:5173/admin`
- backend: `http://localhost:3000`

## Variables de entorno relevantes

### Backend

Definidas en [backend/.env.example](/Users/nicoavayu/Downloads/Mozzo/backend/.env.example).

Obligatorias para admin:

- `ADMIN_PASSWORD`
- `ADMIN_TOKEN_SECRET`

Opcionales:

- `PORT`
- `DB_PATH` o `DATABASE_PATH`
- `UPLOAD_DIR`
- `FRONTEND_URL`
- `PYTHON_BIN`
- `PROCESS_MENU_SCRIPT`
- `GUEST_FEEDBACK_URL`
- `GUEST_REVIEW_URL`

Notas:

- si no definís `DB_PATH` ni `DATABASE_PATH`, el backend usa `~/.mozzo/data/database.sqlite`
- el backend ya no depende de un `database.sqlite` mutable dentro del repo como path principal

### Frontend

Definidas en `frontend/.env.example`.

- `VITE_API_URL` opcional, con default local

## Scripts principales

En la raíz:

```bash
npm run setup
npm run dev
npm run dev:backend
npm run dev:frontend
npm run db:migrate
npm run db:seed
npm run build
npm run check
npm run smoke
```

Backend:

```bash
npm --prefix backend run smoke
npm --prefix backend run test:sprint5
npm --prefix backend run test:sprint6
npm --prefix backend run test:sprint7
npm --prefix backend run test:hardening
```

Frontend:

```bash
npm --prefix frontend run check
npm --prefix frontend run test:sprint7
```

## Regla operativa clave de la versión actual

- registrar pago **no** cierra la mesa
- la mesa se cierra en una acción aparte
- solo se puede cerrar si el pedido quedó totalmente saldado
- `closed_at` sigue siendo la fuente de verdad del cierre y del historial
