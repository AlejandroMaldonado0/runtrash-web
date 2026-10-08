# Subir RunTrash a un servidor gratuito

Guía paso a paso. **No necesitas tarjeta de crédito.**

La arquitectura queda así:

```
Un solo servicio gratuito (Render)  ->  https://runtrash.onrender.com
Una base de datos gratuita (Neon)   ->  tus datos
```

Todo (las páginas web y la API) queda en **un solo dominio**, así que no
hay que configurar CORS ni dos cuentas en dos proveedores.

---

## Antes de empezar

Cosas que ya están listas en el proyecto:

- La URL de la API se detecta sola (mismo origen).
- La base de datos se conecta con una sola variable: `DATABASE_URL`.
- Las migraciones se aplican solas al arrancar.
- El frontend se sirve desde el mismo servicio.
- Los secretos están ignorados por `.gitignore`.

---

## Paso 1 · Crear la base de datos en Neon

1. Entra en <https://neon.tech> y crea una cuenta.
2. **Create a project** -> ponle nombre `Runtrash`.
3. Elige el plan **Free**.
4. Cuando termine, te muestra un panel con la lista de *endpoints*.
5. Copia la **connection string**. Se ve así:

```
postgresql://USUARIO:CLAVE@ep-xxx-sa-east-1.aws.neon.tech/neondb?sslmode=require
```

6. Guárdala en el portapapeles, la usarás en el Paso 3.

> Deja el proyecto en la región por defecto. Render usa `oregon`, así que
> si puedes elegir una región parecida (Oregon o Virginia) la conexión será
> más rápida.

**Verifica que tu proyecto de Neon tenga una rama activa.** Neon pausa las
bases gratuitas tras unos días sin uso; al volver solo tienes que pulsar
*Resume*.

---

## Paso 2 · Subir el código a GitHub

1. Entra en <https://github.com> y crea un repositorio nuevo.
   - Visibilidad: **Private** (recomendado) o Public.
   - **No** marques "Add a README".

2. Abre la terminal en la carpeta del proyecto:

```powershell
cd C:\Users\USER\Downloads\runtrash\runtrash
```

3. Inicializa y sube:

```powershell
git init
git add .
git commit -m "RunTrash: version inicial"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/runtrash.git
git push -u origin main
```

Si te pide credenciales, usa tu usuario de GitHub y un **Personal Access
Token** como contraseña.

4. **Verifica que no se subido nada secreto.** Ejecuta:

```powershell
git ls-files | Select-String -Pattern "\.env$"
```

Debe mostrar **solo** `.env.example` (si aparece) y **nunca** `servidor/.env`.

---

## Paso 3 · Crear el servicio en Render

1. Entra en <https://render.com> y crea una cuenta.

2. **New > Blueprint** (la forma más rápida).
   - Conecta el repositorio de GitHub.
   - Render detectará el archivo `render.yaml` automáticamente.

3. Te pedirá completar las variables marcadas como secretas. Rellena:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | La connection string del Paso 1 |
| `ADMIN_EMAIL` | El correo que quieras para el admin |
| `ADMIN_PASSWORD` | Una clave **de mínimo 8 caracteres** |

4. Presiona **Apply**.

5. Render empieza a instalar dependencias. Mira los logs; deberías ver:

```
✓ 001_postgres_schema.sql
✓ 005_notificaciones_recuperacion.sql
Migraciones de PostgreSQL completadas.
========================================
RunTrash ejecutándose en http://localhost:10000
========================================
Frontend servido desde /opt/render/project/src
```

---

## Paso 4 · Abrir la aplicación

Cuando el deploy termine, Render muestra algo como:

```
https://runtrash.onrender.com
```

Abre esa dirección en el navegador. Deberías ver la pantalla de login de
RunTrash, con un fondo verde y el logo.

**Prueba que la API responde** (esto confirma que la base de datos conectó):

```
https://runtrash.onrender.com/api/prueba
```

Debe mostrar algo como:

```json
{ "ok": true, "mensaje": "Conexión correcta con PostgreSQL." }
```

---

## Paso 5 · Entrar como administrador

El administrador **no aparece en la pantalla de login** (es intencional).
Entra directo a:

```
https://runtrash.onrender.com/admin.html
```

Usa las credenciales que configuraste en `ADMIN_EMAIL` y `ADMIN_PASSWORD`.

Desde ahí ya puedes crear los usuarios de la empresa y los operarios.

---

## Paso 6 · Crear las cuentas de la empresa

Cuando una empresa se registra en la web, el sistema le asigna los
operarios que tengan su misma localidad.

Para que el reparto funcione, primero crea los operarios desde
`admin.html` y asígnales una localidad ( Kennedy, Chapinero, Suba... ).
Luego la empresa puede registrarse normalmente desde la web.

---

## Cosas que debes saber del plan gratuito

### El servidor se duerme

Render apaga el servicio si no recibe visitas en unos minutos.

La primera visita después de dormir tarda entre **30 y 60 segundos** en
cargar. Las siguientes son rápidas. No es un fallo, es el plan gratis.

**Truco:** si quieres que nunca se duerma, puedes abrir
<https://cron-job.org> y crear un tarea cada 10 minutos que haga un ping a
`https://tu-sitio.onrender.com/api/prueba`.

### Las fotos se borran al redesplegar

Este es el punto que más confunde, así que léelo aunque lo demás esté bien.

**El problema:** las imágenes se guardan en el disco del servidor. En el
plan gratis de Render ese disco es **temporal**: cada vez que Render
redespliega (y lo hace con cada `git push`) se borra.

**Qué se pierde y qué no:**

| Dato | ¿Se pierde? |
|---|---|
| Usuarios, reportes, estados, notificaciones | ❌ No (están en Neon) |
| Las **fotos** de los reportes | ✅ Sí (estaban en el disco) |

**La solución:** RunTrash ya trae soporte para **Neon Object Storage**.
Con solo agregar 3 variables en Render, las fotos dejan de depender del
disco y se conservan para siempre.

#### Cómo activarlo (5 minutos)

**Paso 1 · Crear el bucket en Neon**

1. En la consola de Neon, abre tu proyecto.
2. En el menú de la izquierda haz clic en **Object storage**.
3. Presiona **Create bucket**.
4. Nombre: `uploads` (minúsculas, tal cual).
5. Presiona **Create**.

**Paso 2 · Generar las claves de acceso**

1. Sigue en **Object storage**.
2. Baja hasta la sección **S3** (o *Access keys*).
3. Presiona **Create access key**.
4. Te mostrará dos valores:
   - **Access key ID** → empieza con algo parecido a `neonst_...`
   - **Secret access key** → una cadena larga

Copia ambos. El secret **solo se muestra una vez**: cópialo ya.

**Paso 3 · Pegarlos en Render**

1. Ve a tu servicio en Render.
2. Menú lateral: **Environment**.
3. Presiona **Add Environment Variable** y agrega:

| Key | Value |
|---|---|
| `STORAGE_S3_ENDPOINT` | *(el endpoint S3 que te muestra Neon)* |
| `STORAGE_S3_ACCESS_KEY_ID` | *(la access key ID)* |
| `STORAGE_S3_SECRET_ACCESS_KEY` | *(el secret)* |

4. Presiona **Save**, arriba a la derecha.
5. Arriba a la derecha: **Manual Deploy** → **Deploy latest commit**.

**Paso 4 · Confirmar**

En los logs del deploy debe aparecer:

```
Imágenes: almacenamiento s3 (bucket uploads en us-east-2)
```

Si aparece `(disco local, se perderan al redespliegar)`, es que falta
alguna variable.

> **Nota sobre seguridad:** las URLs de las fotos son públicas para quien
> tenga el enlace (igual que antes). Si necesitas que solo los usuarios
> con sesión puedan verlas, dilo y lo ajusto.

### La base de datos también se pausa

Neon pausa el proyecto tras unos días sin uso. Cuando vayas a usarlo,
entra al panel de Neon y pulsa **Resume**. Tus datos siguen ahí.

---

## Errores comunes

| Síntoma | Causa | Solución |
|---|---|---|
| "Conexión correcta" no aparece | `DATABASE_URL` mal pegada | Vuelve a copiarla del panel de Neon |
| Sale `ADMIN_PASSWORD no está configurada` | La clave tiene menos de 8 caracteres | Pon una de 8 o más y redespliega |
| La web carga pero no conecta | `FRONTEND_DIR` vacía | Verifica que diga `/opt/render/project/src` |
| "Demasiados intentos" al entrar | `TRUST_PROXY` en false | Ponlo en `true` y redespliega |
| Los mapas no cargan | Sin salida a internet | El mapa necesita internet; no es problema del hosting |
| El servicio dice "Build failed" | Falló `npm install` | Revisa los logs en Render |

---

## Cómo actualizar después

Cada vez que modifiques el código:

```powershell
git add .
git commit -m "Describe el cambio"
git push
```

Render detecta el push y redespliega solo, aplicando las migraciones
nuevas automáticamente.

---

## Alternativa: frontend separado

Si en el futuro quieres el frontend en Netlify y solo la API en Render:

1. En Netlify, publica el repositorio con:
   - Build command: *(vacío)*
   - Publish directory: `.`
2. Abre `config.js` y descomenta la línea:

```js
window.RUNTRASH_API = "https://runtrash.onrender.com";
```

3. En Render, agrega la URL de Netlify a `CORS_ORIGINS`.

El código ya está preparado para ambas formas.
