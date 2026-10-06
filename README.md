# Web RunTrash

La web usa la API compartida del proyecto. No tiene base de datos propia: todas las operaciones pasan por `server/` y PostgreSQL.

## Desarrollo local

1. Inicia la API desde `server/`.
2. Sirve esta carpeta, por ejemplo:

```bash
python -m http.server 8080
```

3. Abre:

```text
http://localhost:8080/index.html?api=http://localhost:3000
```

La dirección de la API también puede cambiarse con el parámetro `?api=`. Las sesiones se guardan en el navegador y se envían como `Authorization: Bearer <token>`.

Los archivos de esta carpeta son estáticos; no se ejecuta npm aquí. El servidor Express y las migraciones están en `server/`.
