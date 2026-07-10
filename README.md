# Reporting TN

Aplicacion para Tiendanube que permite:

- Conectar rapidamente una tienda por `storeId + accessToken`
- Sincronizar ventas
- Filtrar por fecha y producto
- Generar un link compartible con clave
- Ver reporte en vivo y descargar PDF actualizado

## Requisitos

- Node.js 20+

## Instalacion

1. Instala dependencias:

```bash
npm install
```

2. Configura variables:

```bash
cp .env.example .env
```

3. Inicia en desarrollo:

```bash
npm run dev
```

4. Abre:

```text
http://localhost:3000
```

## Flujo rapido

1. Completa `storeId` y `accessToken` en la UI
2. Click en `Sincronizar ventas ahora`
3. Aplica filtros
4. Crea reporte con nombre y clave
5. Comparte `shareUrl` y clave
6. El receptor ve el reporte en `share.html` con actualizacion en vivo

## Endpoints principales

- `POST /api/connection` guarda credenciales
- `POST /api/tiendanube/sync` sincroniza ventas
- `GET /api/sales` lista ventas filtradas
- `POST /api/reports` crea link protegido
- `GET /api/reports/:slug?password=...` obtiene resumen
- `GET /api/reports/:slug/stream?password=...` actualizaciones SSE
- `GET /api/reports/:slug/pdf?password=...` PDF

## Nota sobre autenticacion Tiendanube

Este MVP usa un `accessToken` ya emitido para simplificar la vinculacion rapida.
Si quieres publicarlo como app del ecosistema Tiendanube, el siguiente paso es implementar OAuth completo (autorizacion, callback y refresh donde aplique).
