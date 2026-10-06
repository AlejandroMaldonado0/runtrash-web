# API RunTrash

API REST compartida por la página web y la aplicación Flutter. PostgreSQL es la base de datos; los clientes nunca se conectan directamente a ella.

## Configuración local

1. Copia `.env.example` como `.env`.
2. Completa `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`.
3. Configura las credenciales del administrador inicial (`ADMIN_*`).
4. Instala y prepara la base de datos:

```bash
npm install
npm run db:migrate
npm run dev
```

La API queda disponible en `http://localhost:3000`. Para un dispositivo Android emulador, Flutter usa `http://10.0.2.2:3000` por defecto. Para un teléfono físico se debe proporcionar la IP local de la computadora mediante `--dart-define=API_BASE_URL=...`.

## Migraciones

- No modifiques una migración que ya fue aplicada.
- Agrega un nuevo archivo SQL en `migrations/` para el siguiente cambio de esquema.
- Ejecuta `npm run db:migrate` antes de iniciar una versión nueva del servidor.
- Haz un backup de PostgreSQL antes de ejecutar cambios destructivos.
