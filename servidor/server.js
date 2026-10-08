require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
    hashPassword,
    verifyPassword,
    hashSessionToken
} = require('./lib/security');
const almacen = require('./lib/almacen');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);
const LOCALIDADES = new Set([
    'Usaquén', 'Suba', 'Kennedy', 'Engativá', 'Fontibón',
    'Los Alpes', 'Chapinero', 'Teusaquillo', 'La Candelaria',
    'San Cristóbal', 'Santa Fe', 'San Andrés', 'Sumapaz',
    'Usura', 'Rafael Uribe', 'Tunjuel', 'Bosa',
    'Ciudad Bolívar', 'Puente Aranda'
]);
const corsOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
/*
Politica de seguridad de contenido (CSP).

Por defecto helmet envia:
    script-src 'self'  y  script-src-attr 'none'
Eso bloquea los <script> dentro del HTML y los onclick="..." de las
botoneras, dejando toda la interfaz sin responder. Solo se nota al
desplegar: en local el servidor estatico no manda esta cabecera.

Por eso se permite 'unsafe-inline' y 'unsafe-eval' en scripts/styles.
Se mantienen el resto de protecciones (frame-ancestors, base-uri,
object-src, upgrade-insecure-requests) y los recursos externos de
Google Fonts y Leaflet.

Para una version endurecida habria que mover los scripts inline a
archivos .js y registrar los onclick con addEventListener.
*/
const cspDirectivas = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    fontSrc: ["'self'", 'https:', 'data:'],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://unpkg.com'],
    scriptSrcAttr: ["'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'https://unpkg.com'],
    connectSrc: ["'self'", 'https:'],
    /*
    Sin frame-src, los iframes caen en default-src 'self' y quedan
    bloqueados. El mapa de cada panel se muestra con un iframe de
    Google Maps, asi que hay que permitirlo explicitamente.
    */
    frameSrc: [
        "'self'",
        'https://maps.google.com',
        'https://www.google.com',
        'https://maps.googleapis.com',
        'https://www.openstreetmap.org',
        'https://www.bing.com'
    ],
    workerSrc: ["'self'", 'blob:'],
    upgradeInsecureRequests: []
};

app.use(helmet({
    contentSecurityPolicy: { directives: cspDirectivas },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
    origin(origin, callback) {
        if (!origin || !corsOrigins.length || corsOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error('Origen no permitido por CORS.'));
    }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 500,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        ok: false,
        mensaje: 'Demasiados intentos. Espera unos minutos e intenta nuevamente.'
    }
});
app.use('/api', generalLimiter);

/*
Conexion a PostgreSQL.

En despliegue se recomienda usar DATABASE_URL (es lo que entrega
Neon, Supabase, Railway o Render). En local puedes seguir usando
DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD por separado.
*/
const connectionString = String(process.env.DATABASE_URL || '').trim();
const usarSslRemoto = connectionString
    || String(process.env.DB_SSL || '').toLowerCase() === 'true';

const pool = new Pool(
    connectionString
        ? {
            connectionString,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000
        }
        : {
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 5432),
            database: process.env.DB_NAME || 'Runtrash',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
            ssl: usarSslRemoto ? { rejectUnauthorized: false } : undefined,
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000
        }
);

pool.on('error', (error) => {
    console.error('Error inesperado de PostgreSQL:', error);
});

const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

/*
En disco local basta con servir la carpeta. Cuando el
almacenamiento es remoto (Neon Object Storage) no hay archivo
en el disco, asi que se leen del bucket bajo demanda.
*/
if (almacen.modo() === 'local') {
    app.use('/uploads', express.static(uploadsDir));
} else {
    /*
    Express 5 no acepta comodines con asterisco ("*"). El patron
    {*clave} si funciona, pero devuelve un arreglo de segmentos
    ("2026","10","foto.png"), asi que hay que volverlo a unir
    con "/" para obtener la clave real del bucket.
    */
    app.get('/uploads/{*segmentos}', async (req, res) => {
        const clave = Array.isArray(req.params.segmentos)
            ? req.params.segmentos.join('/')
            : String(req.params.segmentos || '');

        if (!almacen.claveSegura(clave)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Ruta de imagen no valida.'
            });
        }

        try {
            const { cuerpo, tipo } = await almacen.leer(clave);
            res.setHeader('Content-Type', tipo);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.send(cuerpo);
        } catch (error) {
            if (error && (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)) {
                return res.status(404).json({ ok: false, mensaje: 'Imagen no encontrada.' });
            }
            console.error('Error leyendo imagen remota:', error);
            res.status(500).json({ ok: false, mensaje: 'No se pudo leer la imagen.' });
        }
    });
}

const clientesEventos = new Set();

async function purgarReportesRetirados() {
    try {
        const configuracion = await pool.query(
            "SELECT valor FROM configuracion_sistema WHERE clave = 'retencion_dias'"
        );
        const dias = Number(configuracion.rows[0]?.valor || 90);

        /*
        Se recuperan las imagenes antes de borrar, para eliminar
        tambien el archivo del almacenamiento y no acumular
        imagenes huerfanas.
        */
        const aBorrar = await pool.query(
            `
            SELECT id, imagen_url
            FROM reportes
            WHERE fecha < NOW() - ($1 * INTERVAL '1 day')
              AND imagen_url IS NOT NULL
            `,
            [dias]
        );

        const resultado = await pool.query(
            `
            DELETE FROM reportes
            WHERE fecha < NOW() - ($1 * INTERVAL '1 day')
            `,
            [dias]
        );

        for (const reporte of aBorrar.rows) {
            try {
                await almacen.eliminar(
                    String(reporte.imagen_url).replace(/^\/uploads\//, '')
                );
            } catch (errorImagen) {
                console.error(
                    `No se pudo borrar la imagen del reporte ${reporte.id}:`,
                    errorImagen
                );
            }
        }

        if (resultado.rowCount > 0) {
            console.log(`Reportes eliminados por retención: ${resultado.rowCount}`);
        }
    } catch (error) {
        console.error('Error aplicando retención:', error);
    }
}

function emitirEvento(tipo, datos = {}) {
    const mensaje = `data: ${JSON.stringify({ tipo, ...datos, fecha: new Date().toISOString() })}\n\n`;
    for (const cliente of clientesEventos) {
        cliente.write(mensaje);
    }
}

/*
=========================================================
CENTRO DE NOTIFICACIONES
=========================================================
*/

async function notificarUsuarios(usuarioIds, notificacion) {
    const destinatarios = [...new Set((usuarioIds || []).filter(Boolean))];

    if (!destinatarios.length) return 0;

    const {
        tipo = 'info',
        titulo,
        mensaje = '',
        referenciaTipo = null,
        referenciaId = null
    } = notificacion;

    try {
        const resultado = await pool.query(
            `
            INSERT INTO notificaciones
                (usuario_id, tipo, titulo, mensaje, referencia_tipo, referencia_id)
            SELECT UNNEST($1::int[]), $2, $3, $4, $5, $6
            `,
            [destinatarios, tipo, titulo, mensaje, referenciaTipo, referenciaId]
        );
        return resultado.rowCount;
    } catch (error) {
        console.error('Error guardando notificación:', error);
        return 0;
    }
}

/*
Obtiene los ids de usuarios por rol, opcionalmente filtrando
por empresa y/o excluyendo cuentas inactivas.
*/
async function idsPorRol(tipoUsuario, { empresaId = null } = {}) {
    const condiciones = ['tipo_usuario = $1', 'activo = TRUE'];
    const valores = [tipoUsuario];

    if (empresaId !== null) {
        valores.push(empresaId);
        condiciones.push(`empresa_id = $${valores.length}`);
    }

    const resultado = await pool.query(
        `SELECT id FROM usuarios WHERE ${condiciones.join(' AND ')}`,
        valores
    );

    return resultado.rows.map((row) => row.id);
}

function obtenerToken(req) {
    const encabezado = req.headers.authorization || '';
    const token = encabezado.startsWith('Bearer ')
        ? encabezado.slice(7).trim()
        : String(req.query.token || '').trim();
    return token;
}

async function requiereSesion(req, res, next) {
    const token = obtenerToken(req);

    if (!token) {
        return res.status(401).json({
            ok: false,
            mensaje: 'Debes iniciar sesión.'
        });
    }

    try {
        const resultado = await pool.query(
            `
            SELECT
                u.id,
                u.nombre,
                u.correo,
                u.tipo_usuario,
                u.codigo_operario,
                u.zona_asignada,
                u.empresa_id,
                u.nit_empresa,
                u.activo
            FROM sesiones s
            INNER JOIN usuarios u ON u.id = s.usuario_id
            WHERE s.token = $1
              AND s.expira > NOW()
              AND u.activo = TRUE
            LIMIT 1
            `,
            [hashSessionToken(token)]
        );

        if (resultado.rowCount === 0) {
            return res.status(401).json({
                ok: false,
                mensaje: 'Tu sesión expiró o no es válida.'
            });
        }

        req.usuarioAutenticado = resultado.rows[0];
        next();
    } catch (error) {
        console.error('Error validando sesión:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al validar la sesión.'
        });
    }
}

function requiereRoles(...roles) {
    return (req, res, next) => {
        if (!req.usuarioAutenticado) {
            return res.status(401).json({
                ok: false,
                mensaje: 'Debes iniciar sesión.'
            });
        }

        if (!roles.includes(req.usuarioAutenticado.tipo_usuario)) {
            return res.status(403).json({
                ok: false,
                mensaje: 'No tienes permisos para realizar esta acción.'
            });
        }

        next();
    };
}

const requiereAdmin = [requiereSesion, requiereRoles('admin')];
const requiereCiudadano = [requiereSesion, requiereRoles('ciudadano')];
const requiereOperario = [requiereSesion, requiereRoles('operario')];
const requiereEmpresa = [requiereSesion, requiereRoles('empresa', 'admin')];

/*
Con memoryStorage el archivo todavía no existe en disco, así que
no hay nada que borrar aquí: la imagen solo se escribe cuando la
peticion es válida. Si ya se guardó y la petición falla después,
se llama a almacen.eliminar() con la clave devuelta.
*/
function eliminarArchivoTemporal(_file) {
    return;
}

async function inicializarAdministrador() {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;

    if (
        String(process.env.ADMIN_PASSWORD).length < 8 ||
        process.env.ADMIN_PASSWORD === 'cambia_esta_clave_de_administrador'
    ) {
        console.warn('ADMIN_PASSWORD no está configurada; no se creó/actualizó el administrador.');
        return;
    }

    const adminEmail = String(process.env.ADMIN_EMAIL).trim().toLowerCase();
    const adminName = process.env.ADMIN_NAME || 'Administrador RunTrash';
    const adminPasswordHash = hashPassword(process.env.ADMIN_PASSWORD);

    const existing = await pool.query(
        'SELECT id FROM usuarios WHERE LOWER(correo) = $1 LIMIT 1',
        [adminEmail]
    );

    if (existing.rowCount > 0) {
        await pool.query(
            `
            UPDATE usuarios
            SET nombre = $1,
                password = $2,
                tipo_usuario = 'admin',
                activo = TRUE
            WHERE id = $3
            `,
            [adminName, adminPasswordHash, existing.rows[0].id]
        );
        return;
    }

    await pool.query(
        `
        INSERT INTO usuarios (nombre, correo, password, tipo_usuario, activo)
        VALUES ($1, $2, $3, 'admin', TRUE)
        `,
        [adminName, adminEmail, adminPasswordHash]
    );
}

async function limpiarSesionesExpiradas() {
    await pool.query('DELETE FROM sesiones WHERE expira <= NOW()');
}

/*
=========================================================
IMÁGENES
=========================================================
La extension se normaliza en el fileFilter de multer y la
clave final la decide lib/almacen (disco o Neon Object Storage).
*/

const upload = multer({

    /*
    memoryStorage: multer deja la imagen en memoria y la escribe
    lib/almacen, que decide si va al disco o a Neon Object Storage.
    Asi el codigo es el mismo en local y en produccion, y no queda
    ningun archivo huerfano cuando se rechaza la peticion.
    */
    storage: multer.memoryStorage(),

    limits: {
        fileSize: MAX_UPLOAD_MB * 1024 * 1024
    },

    fileFilter: (_req, file, callback) => {

        const tiposPermitidos = [
            'image/jpeg',
            'image/png',
            'image/webp'
        ];

        if (tiposPermitidos.includes(file.mimetype)) {

            callback(null, true);

        } else {

            callback(
                new Error(
                    'Solo se permiten imágenes JPG, PNG o WEBP.'
                )
            );
        }
    }
});

/*
=========================================================
PRUEBA
=========================================================
*/

app.get('/api/prueba', async (_req, res) => {

    try {

        const resultado = await pool.query(
            'SELECT NOW() AS ahora'
        );

        res.json({
            ok: true,
            mensaje: 'Conexión correcta con PostgreSQL.',
            ahora: resultado.rows[0].ahora
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false,
            mensaje: 'No se pudo conectar a PostgreSQL.'
        });
    }
});

app.get('/api/eventos', requiereSesion, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify({ tipo: 'conectado', fecha: new Date().toISOString() })}\n\n`);
    clientesEventos.add(res);

    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        clientesEventos.delete(res);
    });
});

/*
=========================================================
REGISTRO
=========================================================
*/

app.post('/api/registro', authLimiter, async (req, res) => {

    try {

        const {
            nombre,
            correo,
            password,
            tipo_usuario,
            codigo_operario,
            zona_asignada,
            empresa_id,
            nit_empresa
        } = req.body;

        const tiposPermitidos = [
            'ciudadano',
            'operario',
            'empresa'
        ];

        if (
            !nombre ||
            !correo ||
            !password ||
            !tipo_usuario
        ) {

            return res.status(400).json({
                ok: false,
                mensaje: 'Faltan datos obligatorios.'
            });
        }

        if (String(password).length < 6) {

            return res.status(400).json({
                ok: false,
                mensaje:
                    'La contraseña debe tener mínimo 6 caracteres.'
            });
        }

        if (!tiposPermitidos.includes(tipo_usuario)) {

            return res.status(400).json({
                ok: false,
                mensaje: 'Tipo de usuario no válido.'
            });
        }

        const correoNormalizado =
            String(correo).trim().toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoNormalizado)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'El correo no tiene un formato válido.'
            });
        }

        /*
        COMPROBAR CORREO
        */

        const existeCorreo = await pool.query(
            `
            SELECT id
            FROM usuarios
            WHERE LOWER(correo) = $1
            LIMIT 1
            `,
            [correoNormalizado]
        );

        if (existeCorreo.rowCount > 0) {

            return res.status(409).json({
                ok: false,
                mensaje: 'El correo ya está registrado.'
            });
        }

        /*
        COMPROBAR CÓDIGO DE OPERARIO
        */

        if (tipo_usuario === 'operario') {

            if (!codigo_operario) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'El código de operario es obligatorio.'
                });
            }

            if (!zona_asignada || !LOCALIDADES.has(String(zona_asignada).trim())) {

                return res.status(400).json({
                    ok: false,
                    mensaje: 'Selecciona una localidad válida para el operario.'
                });
            }

            const existeCodigo = await pool.query(
                `
                SELECT id
                FROM usuarios
                WHERE codigo_operario = $1
                LIMIT 1
                `,
                [String(codigo_operario).trim()]
            );

            if (existeCodigo.rowCount > 0) {

                return res.status(409).json({
                    ok: false,
                    mensaje:
                        'El código de operario ya está registrado.'
                });
            }
        }

        /*
        COMPROBAR NIT DE EMPRESA
        */

        if (tipo_usuario === 'empresa') {

            if (!nit_empresa || !String(nit_empresa).trim()) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'El NIT de la empresa es obligatorio.'
                });
            }

            const nitNormalizado =
                String(nit_empresa).trim();

            const existeNit = await pool.query(
                `
                SELECT id
                FROM empresas
                WHERE nit = $1
                UNION ALL
                SELECT id
                FROM usuarios
                WHERE nit_empresa = $1
                LIMIT 1
                `,
                [nitNormalizado]
            );

            if (existeNit.rowCount > 0) {

                return res.status(409).json({
                    ok: false,
                    mensaje:
                        'El NIT de la empresa ya está registrado.'
                });
            }
        }

        /*
        INSERTAR USUARIO
        */

        const client = await pool.connect();

        try {
            await client.query('BEGIN');
            let empresaId = null;

            if (tipo_usuario === 'empresa') {
                const empresa = await client.query(
                    `
                    INSERT INTO empresas (nombre, nit, correo)
                    VALUES ($1, $2, $3)
                    RETURNING id
                    `,
                    [
                        String(nombre).trim(),
                        String(nit_empresa).trim(),
                        correoNormalizado
                    ]
                );
                empresaId = empresa.rows[0].id;
            }

            const resultado = await client.query(
                `
                INSERT INTO usuarios
                (
                    nombre,
                    correo,
                    password,
                    tipo_usuario,
                    codigo_operario,
                    zona_asignada,
                    empresa_id,
                    nit_empresa
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING
                    id,
                    nombre,
                    correo,
                    tipo_usuario,
                    codigo_operario,
                    zona_asignada,
                    empresa_id,
                    nit_empresa,
                    activo
                `,
                [
                    String(nombre).trim(),
                    correoNormalizado,
                    hashPassword(password),
                    tipo_usuario,
                    codigo_operario
                        ? String(codigo_operario).trim()
                        : null,
                    zona_asignada
                        ? String(zona_asignada).trim()
                        : null,
                    empresaId,
                    nit_empresa
                        ? String(nit_empresa).trim()
                        : null
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                ok: true,
                mensaje: 'Usuario registrado correctamente.',
                usuario: resultado.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {

        console.error(
            'ERROR REGISTRANDO USUARIO:',
            error
        );

        if (error.code === '23505') {
            return res.status(409).json({
                ok: false,
                mensaje: 'El correo, NIT o código ya está registrado.'
            });
        }

        res.status(500).json({
            ok: false,
            mensaje: 'Error al registrar usuario.'
        });
    }
});

/*
=========================================================
LOGIN
=========================================================
*/

app.post('/api/login', authLimiter, async (req, res) => {

    try {

        const {
            correo,
            password,
            tipo_usuario,
            codigo_operario,
            nit_empresa
        } = req.body;

        if (!correo || !password) {

            return res.status(400).json({
                ok: false,
                mensaje:
                    'Correo y contraseña son obligatorios.'
            });
        }

        const correoNormalizado =
            String(correo).trim().toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoNormalizado)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'El correo no tiene un formato válido.'
            });
        }

        const resultado = await pool.query(
            `
            SELECT
                id,
                nombre,
                correo,
                password,
                tipo_usuario,
                codigo_operario,
                zona_asignada,
                empresa_id,
                nit_empresa,
                activo
            FROM usuarios
            WHERE LOWER(correo) = $1
            LIMIT 1
            `,
            [correoNormalizado]
        );

        if (resultado.rowCount === 0) {

            return res.status(401).json({
                ok: false,
                mensaje:
                    'Correo o contraseña incorrectos.'
            });
        }

        if (!verifyPassword(password, resultado.rows[0].password)) {

            return res.status(401).json({
                ok: false,
                mensaje: 'Correo o contraseña incorrectos.'
            });
        }

        const usuario =
            resultado.rows[0];

        delete usuario.password;

        if (!usuario.activo) {

            return res.status(403).json({
                ok: false,
                mensaje:
                    'Esta cuenta está desactivada. Contacta al administrador.'
            });
        }

        // El rol se toma de PostgreSQL. El selector de la interfaz es solo
        // una ayuda visual; no debe impedir que la misma cuenta entre desde
        // la web o desde la aplicación.
        const token = crypto.randomBytes(48).toString('hex');

        await pool.query(
            `
            INSERT INTO sesiones
                (usuario_id, token, expira)
            VALUES
                ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))
            `,
            [usuario.id, hashSessionToken(token), SESSION_HOURS]
        );

        res.json({
            ok: true,
            mensaje: 'Inicio de sesión correcto.',
            usuario: usuario,
            token: token
        });

    } catch (error) {

        console.error(
            'ERROR EN LOGIN:',
            error
        );

        res.status(500).json({
            ok: false,
            mensaje: 'Error al iniciar sesión.'
        });
    }
});

app.get('/api/me', requiereSesion, async (req, res) => {
    res.json({
        ok: true,
        usuario: req.usuarioAutenticado
    });
});

app.post('/api/logout', async (req, res) => {
    const token = obtenerToken(req);

    if (token) {
        await pool.query(
            'DELETE FROM sesiones WHERE token = $1',
            [hashSessionToken(token)]
        );
    }

    res.json({
        ok: true,
        mensaje: 'Sesión cerrada correctamente.'
    });
});

app.post('/api/password/cambiar', requiereSesion, async (req, res) => {
    try {
        const currentPassword = String(req.body.current_password || '');
        const newPassword = String(req.body.new_password || '');

        if (newPassword.length < 6) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La nueva contraseña debe tener mínimo 6 caracteres.'
            });
        }

        const result = await pool.query(
            `
            SELECT password
            FROM usuarios
            WHERE id = $1
              AND activo = TRUE
            `,
            [req.usuarioAutenticado.id]
        );
        const currentHash = result.rows[0]?.password || '';
        if (!verifyPassword(currentPassword, currentHash)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La contraseña actual no es correcta.'
            });
        }

        await pool.query(
            'UPDATE usuarios SET password = $1 WHERE id = $2',
            [hashPassword(newPassword), req.usuarioAutenticado.id]
        );
        await pool.query(
            'DELETE FROM sesiones WHERE usuario_id = $1',
            [req.usuarioAutenticado.id]
        );

        res.json({
            ok: true,
            mensaje: 'Contraseña actualizada. Inicia sesión nuevamente.'
        });
    } catch (error) {
        console.error('Error cambiando contraseña:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudo cambiar la contraseña.'
        });
    }
});

/*
=========================================================
CENTRO DE NOTIFICACIONES
=========================================================
*/

app.get('/api/notificaciones', requiereSesion, async (req, res) => {
    try {
        const usuarioId = req.usuarioAutenticado.id;

        const resultado = await pool.query(
            `
            SELECT id, tipo, titulo, mensaje, referencia_tipo, referencia_id, leida, fecha
            FROM notificaciones
            WHERE usuario_id = $1
            ORDER BY leida ASC, fecha DESC
            LIMIT 40
            `,
            [usuarioId]
        );

        const noLeidas = await pool.query(
            `
            SELECT COUNT(*)::int AS total
            FROM notificaciones
            WHERE usuario_id = $1 AND leida = FALSE
            `,
            [usuarioId]
        );

        res.json({
            ok: true,
            notificaciones: resultado.rows,
            no_leidas: noLeidas.rows[0].total
        });
    } catch (error) {
        console.error('Error listando notificaciones:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudieron cargar las notificaciones.'
        });
    }
});

app.post('/api/notificaciones/leidas', requiereSesion, async (req, res) => {
    try {
        const resultado = await pool.query(
            `
            UPDATE notificaciones
            SET leida = TRUE
            WHERE usuario_id = $1 AND leida = FALSE
            `,
            [req.usuarioAutenticado.id]
        );

        emitirEvento('notificaciones_leidas', {
            usuario_id: req.usuarioAutenticado.id
        });

        res.json({
            ok: true,
            mensaje: 'Notificaciones marcadas como leídas.',
            marcadas: resultado.rowCount
        });
    } catch (error) {
        console.error('Error marcando notificaciones:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudieron marcar las notificaciones.'
        });
    }
});

/*
=========================================================
RECUPERACIÓN DE CONTRASEÑA
=========================================================
*/

const RECUPERACION_MINUTOS = Number(process.env.RECUPERACION_MINUTOS || 20);
const RECUPERACION_INTENTOS = Number(process.env.RECUPERACION_INTENTOS || 5);

/*
En modo demostración el código se devuelve en la respuesta para
poder completar el flujo sin servidor de correo. En producción se
envía por correo y la respuesta nunca incluye el código.
*/
const EXPONER_CODIGO = String(
    process.env.EXPOSER_CODIGO_RECUPERACION || 'true'
).toLowerCase() !== 'false';

function generarCodigoRecuperacion() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function correoValido(correo) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

app.post('/api/password/recuperar/solicitar', authLimiter, async (req, res) => {
    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();

        if (!correoValido(correo)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Ingresa un correo válido.'
            });
        }

        const usuario = await pool.query(
            `
            SELECT id, nombre, correo, activo
            FROM usuarios
            WHERE LOWER(correo) = $1
            LIMIT 1
            `,
            [correo]
        );

        const mensajeGenerico = 'Si el correo está registrado, enviamos un código de recuperación.';

        if (usuario.rowCount === 0) {
            return res.json({ ok: true, mensaje: mensajeGenerico });
        }

        const cuenta = usuario.rows[0];

        if (!cuenta.activo) {
            return res.json({ ok: true, mensaje: mensajeGenerico });
        }

        await pool.query(
            `
            UPDATE password_recuperaciones
            SET usado = TRUE
            WHERE usuario_id = $1 AND usado = FALSE
            `,
            [cuenta.id]
        );

        const codigo = generarCodigoRecuperacion();

        await pool.query(
            `
            INSERT INTO password_recuperaciones
                (usuario_id, codigo_hash, expira)
            VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)
            `,
            [cuenta.id, hashPassword(codigo), String(RECUPERACION_MINUTOS)]
        );

        console.log(`Código de recuperación para ${cuenta.correo}: ${codigo}`);

        res.json({
            ok: true,
            mensaje: mensajeGenerico,
            ...(EXPONER_CODIGO ? { codigo_demo: codigo } : {})
        });
    } catch (error) {
        console.error('Error solicitando recuperación:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudo iniciar la recuperación.'
        });
    }
});

async function validarCodigoRecuperacion(correo, codigo) {
    const resultado = await pool.query(
        `
        SELECT r.id, r.codigo_hash, r.expira, r.intentos
        FROM password_recuperaciones r
        JOIN usuarios u ON u.id = r.usuario_id
        WHERE LOWER(u.correo) = $1
          AND r.usado = FALSE
        ORDER BY r.creado_en DESC
        LIMIT 1
        `,
        [correo]
    );

    if (resultado.rowCount === 0) return { ok: false, motivo: 'invalido' };

    const registro = resultado.rows[0];

    if (new Date(registro.expira).getTime() < Date.now()) {
        return { ok: false, motivo: 'expirado' };
    }

    if (registro.intentos >= RECUPERACION_INTENTOS) {
        return { ok: false, motivo: 'bloqueado' };
    }

    if (!verifyPassword(codigo, registro.codigo_hash)) {
        await pool.query(
            'UPDATE password_recuperaciones SET intentos = intentos + 1 WHERE id = $1',
            [registro.id]
        );
        return {
            ok: false,
            motivo: 'incorrecto',
            intentosRestantes: Math.max(0, RECUPERACION_INTENTOS - registro.intentos - 1)
        };
    }

    return { ok: true, registro };
}

app.post('/api/password/recuperar/verificar', authLimiter, async (req, res) => {
    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();
        const codigo = String(req.body.codigo || '').trim();

        if (!correoValido(correo) || !/^\d{6}$/.test(codigo)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Ingresa tu correo y el código de 6 dígitos.'
            });
        }

        const validacion = await validarCodigoRecuperacion(correo, codigo);

        if (!validacion.ok) {
            const mensajes = {
                invalido: 'El código no es válido o ya fue usado.',
                expirado: 'El código expiró. Solicita uno nuevo.',
                bloqueado: 'Demasiados intentos. Solicita un código nuevo.',
                incorrecto: 'El código no coincide.'
            };

            return res.status(400).json({
                ok: false,
                motivo: validacion.motivo,
                mensaje: mensajes[validacion.motivo] || 'No se pudo verificar el código.',
                ...(validacion.intentosRestantes !== undefined
                    ? { intentos_restantes: validacion.intentosRestantes }
                    : {})
            });
        }

        res.json({
            ok: true,
            mensaje: 'Código verificado. Define tu nueva contraseña.'
        });
    } catch (error) {
        console.error('Error verificando código:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudo verificar el código.'
        });
    }
});

app.post('/api/password/recuperar/restablecer', authLimiter, async (req, res) => {
    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();
        const codigo = String(req.body.codigo || '').trim();
        const nuevaPassword = String(req.body.password || '');

        if (!correoValido(correo) || !/^\d{6}$/.test(codigo)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Solicita un código de recuperación válido.'
            });
        }

        if (nuevaPassword.length < 6) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La contraseña debe tener mínimo 6 caracteres.'
            });
        }

        const validacion = await validarCodigoRecuperacion(correo, codigo);

        if (!validacion.ok) {
            return res.status(400).json({
                ok: false,
                mensaje: 'El código no es válido, expiró o superaste los intentos.'
            });
        }

        const cuenta = await pool.query(
            'SELECT id FROM usuarios WHERE LOWER(correo) = $1 LIMIT 1',
            [correo]
        );

        const usuarioId = cuenta.rows[0].id;

        await pool.query(
            'UPDATE usuarios SET password = $1 WHERE id = $2',
            [hashPassword(nuevaPassword), usuarioId]
        );

        await pool.query(
            'UPDATE password_recuperaciones SET usado = TRUE WHERE id = $1',
            [validacion.registro.id]
        );

        await pool.query(
            'DELETE FROM sesiones WHERE usuario_id = $1',
            [usuarioId]
        );

        emitirEvento('password_restablecida', { usuario_id: usuarioId });

        res.json({
            ok: true,
            mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión.'
        });
    } catch (error) {
        console.error('Error restableciendo contraseña:', error);
        res.status(500).json({
            ok: false,
            mensaje: 'No se pudo actualizar la contraseña.'
        });
    }
});

/*
=========================================================
CREAR REPORTE
=========================================================
*/

app.post(
    '/api/reportes',
    requiereCiudadano,
    upload.single('imagen'),
    async (req, res) => {

        /*
        Se declara antes del try porque el bloque catch la usa
        para borrar la imagen si algo falla mas adelante. Si se
        declarara dentro, al fallar una validacion early todavia
        no existiria y saltaria un ReferenceError que taparia
        el error real.
        */
        let imagen_url = null;

        try {

            const {
                tipo,
                descripcion,
                ubicacion,
                localidad,
                latitud,
                longitud
            } = req.body;
            const usuarioId = req.usuarioAutenticado.id;

            const tipoNormalizado = String(tipo || '').trim();
            const descripcionNormalizada = String(descripcion || '').trim();
            const ubicacionNormalizada = String(ubicacion || '').trim();

            if (!['Basura', 'Escombro', 'Acumulación de residuos', 'Basura en vía pública', 'Residuos en zona verde', 'Otro'].includes(tipoNormalizado)) {
                eliminarArchivoTemporal(req.file);
                return res.status(400).json({
                    ok: false,
                    mensaje: 'Selecciona Basura o Escombro.'
                });
            }

            if (!descripcionNormalizada) {
                eliminarArchivoTemporal(req.file);
                return res.status(400).json({
                    ok: false,
                    mensaje: 'Debes escribir una descripción.'
                });
            }

            if (descripcionNormalizada.length > 100) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'La descripción puede tener máximo 100 caracteres.'
                });
            }

            if (!ubicacionNormalizada || ubicacionNormalizada.length > 300) {
                eliminarArchivoTemporal(req.file);
                return res.status(400).json({
                    ok: false,
                    mensaje: 'Indica una ubicación válida de máximo 300 caracteres.'
                });
            }

            if (!localidad || !LOCALIDADES.has(String(localidad).trim())) {

                eliminarArchivoTemporal(req.file);

                return res.status(400).json({
                    ok: false,
                    mensaje: 'Debes seleccionar una localidad válida.'
                });
            }

            if (!req.file) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'Debes adjuntar una foto del reporte.'
                });
            }

            const configuracion = await pool.query(
                `
                SELECT valor
                FROM configuracion_sistema
                WHERE clave = 'limite_reportes_diarios'
                `
            );
            const limiteReportesDiarios = Number(configuracion.rows[0]?.valor || 5);
            const reportesHoy = await pool.query(
                `
                SELECT COUNT(*)::integer AS total
                FROM reportes
                WHERE usuario_id = $1
                  AND fecha >= CURRENT_DATE
                  AND fecha < CURRENT_DATE + INTERVAL '1 day'
                `,
                [usuarioId]
            );

            if (reportesHoy.rows[0].total >= limiteReportesDiarios) {

                return res.status(429).json({
                    ok: false,
                    mensaje:
                        `Alcanzaste el límite de ${limiteReportesDiarios} reportes diarios.`
                });
            }

            if (req.file) {
                /*
                multer deja la foto en memoria (req.file.buffer).
                Se la pasamos a lib/almacen, que escribe en disco
                local o en Neon Object Storage segun la configuracion,
                y devuelve la ruta publica.
                */
                const extension = path
                    .extname(req.file.originalname || '')
                    .toLowerCase();

                const extensionValida = ['.jpg', '.jpeg', '.png', '.webp']
                    .includes(extension)
                        ? extension
                        : '.jpg';

                const clave = await almacen.guardar(
                    req.file.buffer,
                    extensionValida
                );

                imagen_url = `/uploads/${clave}`;
            }

            let latitudFinal = null;
            let longitudFinal = null;

            if (
                latitud !== undefined &&
                latitud !== null &&
                latitud !== ''
            ) {

                latitudFinal =
                    Number(latitud);
            }

            if (
                longitud !== undefined &&
                longitud !== null &&
                longitud !== ''
            ) {

                longitudFinal =
                    Number(longitud);
            }

            const coordenadasIncompletas =
                (latitudFinal === null) !== (longitudFinal === null);

            const coordenadasInvalidas =
                (latitudFinal !== null && (!Number.isFinite(latitudFinal) || latitudFinal < -90 || latitudFinal > 90))
                || (longitudFinal !== null && (!Number.isFinite(longitudFinal) || longitudFinal < -180 || longitudFinal > 180));

            if (coordenadasIncompletas || coordenadasInvalidas) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'Las coordenadas GPS no son válidas.'
                });
            }

            const resultado = await pool.query(
                `
                INSERT INTO reportes
                (
                    usuario_id,
                    tipo,
                    descripcion,
                    ubicacion,
                    localidad,
                    latitud,
                    longitud,
                    estado,
                    imagen_url
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,'pendiente',$8)
                RETURNING *
                `,
                [
                    usuarioId,
                    tipoNormalizado,
                    descripcionNormalizada,
                    ubicacionNormalizada,
                    String(localidad).trim(),
                    latitudFinal,
                    longitudFinal,
                    imagen_url
                ]
            );

            let reporteCreado = resultado.rows[0];
            let operarioAsignado = null;

            const operadorSector = await pool.query(
                `
                SELECT
                    u.id,
                    u.nombre,
                    COUNT(r.id)::integer AS reportes_activos
                FROM usuarios u
                LEFT JOIN reportes r
                    ON r.operario_id = u.id
                   AND r.estado <> 'completado'
                WHERE u.tipo_usuario = 'operario'
                  AND u.activo = TRUE
                  AND LOWER(u.zona_asignada) = LOWER($1)
                GROUP BY u.id, u.nombre
                ORDER BY reportes_activos ASC, u.id ASC
                LIMIT 1
                `,
                [String(localidad).trim()]
            );

            if (operadorSector.rowCount > 0) {
                const operador = operadorSector.rows[0];
                const asignacionAutomatica = await pool.query(
                    `
                    UPDATE reportes
                    SET operario_id = $1,
                        estado = 'en proceso'
                    WHERE id = $2
                    RETURNING *
                    `,
                    [operador.id, reporteCreado.id]
                );
                reporteCreado = asignacionAutomatica.rows[0];
                operarioAsignado = operador;
            }

            console.log(
                'Reporte creado:',
                reporteCreado
            );

            emitirEvento('reporte_creado', {
                reporte_id: reporteCreado.id,
                localidad: reporteCreado.localidad,
                operario_id: reporteCreado.operario_id
            });

            /* Avisos del centro de notificaciones */
            const localityLabel = reporteCreado.localidad || 'sin localidad';

            await notificarUsuarios(
                await idsPorRol('empresa'),
                {
                    tipo: 'reporte_nuevo',
                    titulo: 'Nuevo reporte recibido',
                    mensaje: `${reporteCreado.tipo} en ${localityLabel}.`,
                    referenciaTipo: 'reporte',
                    referenciaId: reporteCreado.id
                }
            );

            await notificarUsuarios(
                await idsPorRol('admin'),
                {
                    tipo: 'reporte_nuevo',
                    titulo: 'Nuevo reporte en la plataforma',
                    mensaje: `${reporteCreado.tipo} en ${localityLabel}.`,
                    referenciaTipo: 'reporte',
                    referenciaId: reporteCreado.id
                }
            );

            if (operarioAsignado) {
                await notificarUsuarios([operarioAsignado.id], {
                    tipo: 'asignacion',
                    titulo: 'Te asignaron un reporte',
                    mensaje: `${reporteCreado.tipo} en ${localityLabel}.`,
                    referenciaTipo: 'reporte',
                    referenciaId: reporteCreado.id
                });
            }

            res.status(201).json({
                ok: true,
                mensaje:
                    operarioAsignado
                        ? 'Reporte creado y asignado automáticamente.'
                        : 'Reporte creado correctamente.',
                reporte:
                    reporteCreado,
                operario_asignado:
                    operarioAsignado
            });

        } catch (error) {

            console.error(
                'ERROR CREANDO REPORTE:',
                error
            );

            /*
            Si la imagen ya se habia escrito y despues fallo algo
            (por ejemplo el INSERT), se borra para no dejar archivos
            huerfanos en el almacenamiento.
            */
            if (imagen_url) {
                try {
                    await almacen.eliminar(
                        imagen_url.replace(/^\/uploads\//, '')
                    );
                } catch (errorLimpieza) {
                    console.error(
                        'No se pudo limpiar la imagen huérfana:',
                        errorLimpieza
                    );
                }
            }

            res.status(500).json({
                ok: false,
                mensaje:
                    'Error al crear el reporte.',
                error: error.message
            });
        }
    }
);

/*
=========================================================
REPORTES DE UN CIUDADANO
=========================================================
*/

app.get(
    '/api/reportes/usuario/:usuarioId',
    requiereCiudadano,
    async (req, res) => {

        try {

            const usuarioId =
                Number(req.params.usuarioId);

            if (usuarioId !== req.usuarioAutenticado.id) {
                return res.status(403).json({
                    ok: false,
                    mensaje: 'Solo puedes consultar tus propios reportes.'
                });
            }

            const resultado = await pool.query(
                `
                SELECT
                    r.*,
                    u.nombre AS ciudadano
                FROM reportes r
                INNER JOIN usuarios u
                    ON u.id = r.usuario_id
                WHERE r.usuario_id = $1
                ORDER BY
                    r.fecha DESC,
                    r.id DESC
                `,
                [usuarioId]
            );

            res.json({
                ok: true,
                reportes: resultado.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                mensaje:
                    'Error al cargar tus reportes.'
            });
        }
    }
);

/*
=========================================================
REPORTES DE UN OPERARIO
=========================================================
*/

app.get(
    '/api/reportes/operario/:operarioId',
    requiereOperario,
    async (req, res) => {

        try {

            const operarioId =
                Number(req.params.operarioId);

            if (operarioId !== req.usuarioAutenticado.id) {
                return res.status(403).json({
                    ok: false,
                    mensaje: 'Solo puedes consultar tus propios reportes.'
                });
            }

            const resultado = await pool.query(
                `
                SELECT
                    r.*,
                    u.nombre AS ciudadano
                FROM reportes r
                INNER JOIN usuarios u
                    ON u.id = r.usuario_id
                WHERE r.operario_id = $1
                ORDER BY
                    r.fecha DESC,
                    r.id DESC
                `,
                [operarioId]
            );

            res.json({
                ok: true,
                reportes: resultado.rows
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                mensaje:
                    'Error al cargar los reportes asignados.'
            });
        }
    }
);

/*
=========================================================
TODOS LOS REPORTES
=========================================================
*/

app.get('/api/reportes', requiereEmpresa, async (_req, res) => {

    try {

        const resultado = await pool.query(
            `
            SELECT
                r.*,
                u.nombre AS ciudadano,
                o.nombre AS operario
            FROM reportes r
            INNER JOIN usuarios u
                ON u.id = r.usuario_id
            LEFT JOIN usuarios o
                ON o.id = r.operario_id
            ORDER BY
                r.fecha DESC,
                r.id DESC
            `
        );

        res.json({
            ok: true,
            reportes: resultado.rows
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false,
            mensaje:
                'Error al cargar los reportes.'
        });
    }
});

/*
=========================================================
OPERARIOS
=========================================================
*/

app.get('/api/operarios', requiereEmpresa, async (req, res) => {

    try {

        const empresaId = req.usuarioAutenticado.tipo_usuario === 'admin'
            ? req.query.empresa_id
            : req.usuarioAutenticado.empresa_id;

        if (!empresaId) {
            return res.json({
                ok: true,
                operarios: []
            });
        }

        const consulta = `
            SELECT
                id,
                nombre,
                correo,
                codigo_operario,
                zona_asignada,
                empresa_id
            FROM usuarios
            WHERE tipo_usuario = 'operario'
              AND activo = TRUE
              AND (empresa_id = $1 OR empresa_id IS NULL)
            ORDER BY nombre
        `;

        const parametros = [Number(empresaId)];

        const resultado =
            await pool.query(
                consulta,
                parametros
            );

        res.json({
            ok: true,
            operarios:
                resultado.rows
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            ok: false,
            mensaje:
                'Error al cargar los operarios.'
        });
    }
});

/*
=========================================================
ASIGNAR REPORTE A OPERARIO
=========================================================
*/

app.put(
    '/api/reportes/:id/asignar',
    requiereEmpresa,
    async (req, res) => {

        try {

            const reporteId =
                Number(req.params.id);

            const {
                operario_id
            } = req.body;

            if (!operario_id) {

                return res.status(400).json({
                    ok: false,
                    mensaje:
                        'Debes seleccionar un operario.'
                });
            }

            const operario =
                await pool.query(
                    `
                    SELECT id, nombre, zona_asignada
                    FROM usuarios
                    WHERE id = $1
                      AND tipo_usuario = 'operario'
                      AND activo = TRUE
                      AND ($2::integer IS NULL OR empresa_id = $2 OR empresa_id IS NULL)
                    `,
                    [
                        Number(operario_id),
                        req.usuarioAutenticado.empresa_id
                    ]
                );

            if (operario.rowCount === 0) {

                return res.status(404).json({
                    ok: false,
                    mensaje:
                        'El operario no existe.'
                });
            }

            const resultado =
                await pool.query(
                    `
                    UPDATE reportes
                    SET
                        operario_id = $1,
                        estado = 'en proceso'
                    WHERE id = $2
                      AND operario_id IS NULL
                    RETURNING *
                    `,
                    [
                        Number(operario_id),
                        reporteId
                    ]
                );

            if (resultado.rowCount === 0) {

                return res.status(404).json({
                    ok: false,
                    mensaje:
                        'Reporte no encontrado.'
                });
            }

            emitirEvento('reporte_asignado', {
                reporte_id: reporteId,
                operario_id: Number(operario_id)
            });

            const asignado = resultado.rows[0];

            await notificarUsuarios([Number(operario_id)], {
                tipo: 'asignacion',
                titulo: 'Te asignaron un reporte',
                mensaje: `${asignado.tipo} en ${asignado.localidad || 'sin localidad'}.`,
                referenciaTipo: 'reporte',
                referenciaId: reporteId
            });

            await notificarUsuarios([asignado.usuario_id], {
                tipo: 'asignacion',
                titulo: 'Tu reporte fue asignado',
                mensaje: `${operario.nombre} atenderá tu reporte.`,
                referenciaTipo: 'reporte',
                referenciaId: reporteId
            });

            res.json({
                ok: true,
                mensaje:
                    'Reporte asignado correctamente.',
                reporte:
                    resultado.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                mensaje:
                    'Error al asignar el reporte.'
            });
        }
    }
);

app.post(
    '/api/reportes/:id/asignar-automaticamente',
    requiereEmpresa,
    async (req, res) => {

        try {
            const reporteId = Number(req.params.id);
            const reporte = await pool.query(
                `
                SELECT id, localidad, operario_id
                FROM reportes
                WHERE id = $1
                LIMIT 1
                `,
                [reporteId]
            );

            if (reporte.rowCount === 0) {
                return res.status(404).json({
                    ok: false,
                    mensaje: 'Reporte no encontrado.'
                });
            }

            if (reporte.rows[0].operario_id) {
                return res.status(409).json({
                    ok: false,
                    mensaje: 'El reporte ya tiene un operario asignado.'
                });
            }

            const operador = await pool.query(
                `
                SELECT u.id, u.nombre, u.zona_asignada
                FROM usuarios u
                LEFT JOIN reportes r
                    ON r.operario_id = u.id
                   AND r.estado <> 'completado'
                WHERE u.tipo_usuario = 'operario'
                  AND u.activo = TRUE
                  AND LOWER(u.zona_asignada) = LOWER($1)
                GROUP BY u.id, u.nombre, u.zona_asignada
                ORDER BY COUNT(r.id) ASC, u.id ASC
                LIMIT 1
                `,
                [reporte.rows[0].localidad]
            );

            if (operador.rowCount === 0) {
                return res.status(409).json({
                    ok: false,
                    mensaje: `No hay un operario activo para ${reporte.rows[0].localidad || 'la localidad seleccionada'}.`
                });
            }

            const asignado = await pool.query(
                `
                UPDATE reportes
                SET operario_id = $1,
                    estado = 'en proceso'
                WHERE id = $2
                  AND operario_id IS NULL
                RETURNING *
                `,
                [operador.rows[0].id, reporteId]
            );

            emitirEvento('reporte_asignado', {
                reporte_id: reporteId,
                operario_id: operador.rows[0].id,
                automatico: true
            });

            const autoAsignado = asignado.rows[0];

            await notificarUsuarios([operador.rows[0].id], {
                tipo: 'asignacion',
                titulo: 'Te asignaron un reporte',
                mensaje: `${autoAsignado.tipo} en ${autoAsignado.localidad || 'sin localidad'}.`,
                referenciaTipo: 'reporte',
                referenciaId: reporteId
            });

            await notificarUsuarios([autoAsignado.usuario_id], {
                tipo: 'asignacion',
                titulo: 'Tu reporte fue asignado',
                mensaje: `${operador.rows[0].nombre} atenderá tu reporte.`,
                referenciaTipo: 'reporte',
                referenciaId: reporteId
            });

            res.json({
                ok: true,
                mensaje: 'Reporte asignado por localidad y carga disponible.',
                reporte: asignado.rows[0],
                operario: operador.rows[0]
            });

        } catch (error) {
            console.error(error);
            res.status(500).json({
                ok: false,
                mensaje: 'No se pudo realizar la asignación automática.'
            });
        }
    }
);

/*
=========================================================
CAMBIAR ESTADO
=========================================================
*/

app.put(
    '/api/reportes/:id/estado',
    requiereOperario,
    async (req, res) => {

        try {

            const reporteId =
                Number(req.params.id);

            const estado = String(req.body.estado || '').trim().toLowerCase();
            const operadorId = req.usuarioAutenticado.id;

            if (!['en proceso', 'completado'].includes(estado)) {
                return res.status(400).json({
                    ok: false,
                    mensaje: 'Estado no válido.'
                });
            }

            /*
            El operario puede elegir libremente entre "en proceso" y
            "completado", incluso regresando si se equivocó.
            "pendiente" sigue siendo el estado inicial de todo reporte
            asignado y por eso no se permite fijarlo desde aquí.
            */            const resultado =
                await pool.query(
                    `
                    UPDATE reportes
                    SET estado = $1
                    WHERE id = $2
                      AND operario_id = $3
                    RETURNING *
                    `,
                    [
                        estado,
                        reporteId,
                        operadorId
                    ]
                );

            if (resultado.rowCount === 0) {

                return res.status(404).json({
                    ok: false,
                    mensaje:
                        'El reporte no existe o no está asignado a este operario.'
                });
            }

            emitirEvento('estado_actualizado', {
                reporte_id: reporteId,
                estado: estado,
                operario_id: operadorId
            });

            const actualizado = resultado.rows[0];
            const esCompletado = estado === 'completado';

            await notificarUsuarios([actualizado.usuario_id], {
                tipo: 'estado',
                titulo: esCompletado
                    ? 'Tu reporte fue completado'
                    : 'Tu reporte vuelve a estar en proceso',
                mensaje: `${actualizado.tipo} en ${actualizado.localidad || 'sin localidad'}.`,
                referenciaTipo: 'reporte',
                referenciaId: reporteId
            });

            await notificarUsuarios(
                await idsPorRol('empresa'),
                {
                    tipo: 'estado',
                    titulo: esCompletado ? 'Reporte completado' : 'Reporte en proceso',
                    mensaje: `${actualizado.tipo} en ${actualizado.localidad || 'sin localidad'}.`,
                    referenciaTipo: 'reporte',
                    referenciaId: reporteId
                }
            );

            res.json({
                ok: true,
                mensaje:
                    'Estado actualizado correctamente.',
                reporte:
                    resultado.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                mensaje:
                    'Error al actualizar el estado.'
            });
        }
    }
);

/*
=========================================================
ADMINISTRACIÓN
=========================================================
*/

app.get('/api/admin/resumen', requiereAdmin, async (_req, res) => {
    try {
        const [totales, estados, sectores, recientes, usuariosPorRol] = await Promise.all([
            pool.query(`
                SELECT
                    (SELECT COUNT(*)::integer FROM usuarios) AS usuarios,
                    (SELECT COUNT(*)::integer FROM usuarios WHERE activo = TRUE) AS usuarios_activos,
                    (SELECT COUNT(*)::integer FROM reportes) AS reportes,
                    (SELECT COUNT(*)::integer FROM reportes WHERE fecha >= CURRENT_DATE) AS reportes_hoy
            `),
            pool.query(`
                SELECT estado, COUNT(*)::integer AS total
                FROM reportes
                GROUP BY estado
            `),
            pool.query(`
                SELECT
                    COALESCE(NULLIF(localidad, ''), 'Por geolocalizar') AS sector,
                    COUNT(*)::integer AS total,
                    COUNT(*) FILTER (WHERE estado = 'pendiente')::integer AS pendientes,
                    COUNT(*) FILTER (WHERE estado = 'completado')::integer AS completados
                FROM reportes
                WHERE fecha >= NOW() - INTERVAL '15 days'
                GROUP BY COALESCE(NULLIF(localidad, ''), 'Por geolocalizar')
                ORDER BY total DESC
                LIMIT 12
            `),
            pool.query(`
                SELECT
                    r.id,
                    r.tipo,
                    r.localidad,
                    r.estado,
                    r.fecha,
                    u.nombre AS ciudadano,
                    o.nombre AS operario
                FROM reportes r
                INNER JOIN usuarios u ON u.id = r.usuario_id
                LEFT JOIN usuarios o ON o.id = r.operario_id
                ORDER BY r.fecha DESC, r.id DESC
                LIMIT 8
            `),
            pool.query(`
                SELECT tipo_usuario, COUNT(*)::integer AS total
                FROM usuarios
                GROUP BY tipo_usuario
            `)
        ]);

        res.json({
            ok: true,
            resumen: totales.rows[0],
            estados: estados.rows,
            sectores: sectores.rows,
            recientes: recientes.rows,
            usuarios_por_rol: usuariosPorRol.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al cargar el resumen.'
        });
    }
});

app.get('/api/admin/usuarios', requiereAdmin, async (_req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT
                u.id,
                u.nombre,
                u.correo,
                u.tipo_usuario,
                u.codigo_operario,
                u.zona_asignada,
                u.nit_empresa,
                u.activo,
                u.empresa_id,
                COUNT(r.id)::integer AS reportes
            FROM usuarios u
            LEFT JOIN reportes r ON r.usuario_id = u.id
            GROUP BY u.id
            ORDER BY u.activo DESC, u.nombre
        `);

        res.json({
            ok: true,
            usuarios: resultado.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al cargar los usuarios.'
        });
    }
});

app.post('/api/admin/usuarios', requiereAdmin, async (req, res) => {
    try {
        const {
            nombre,
            correo,
            password,
            tipo_usuario,
            codigo_operario,
            zona_asignada,
            nit_empresa
        } = req.body;
        const permitidos = ['ciudadano', 'operario', 'empresa'];

        if (!nombre || !correo || !password || !permitidos.includes(tipo_usuario)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Completa los datos obligatorios.'
            });
        }

        if (String(password).length < 6) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La contraseña debe tener mínimo 6 caracteres.'
            });
        }

        if (tipo_usuario === 'operario' && (!codigo_operario || !zona_asignada)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'El operario necesita código y localidad asignada.'
            });
        }

        if (tipo_usuario === 'empresa' && !nit_empresa) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La empresa necesita un NIT.'
            });
        }

        const correoNormalizado = String(correo).trim().toLowerCase();
        const existe = await pool.query(
            'SELECT id FROM usuarios WHERE LOWER(correo) = $1 LIMIT 1',
            [correoNormalizado]
        );

        if (existe.rowCount > 0) {
            return res.status(409).json({
                ok: false,
                mensaje: 'El correo ya está registrado.'
            });
        }

        let empresaId = null;
        if (tipo_usuario === 'empresa') {
            const empresa = await pool.query(
                `
                INSERT INTO empresas (nombre, nit, correo)
                VALUES ($1, $2, $3)
                ON CONFLICT (nit) DO UPDATE
                SET nombre = EXCLUDED.nombre
                RETURNING id
                `,
                [String(nombre).trim(), String(nit_empresa).trim(), correoNormalizado]
            );
            empresaId = empresa.rows[0].id;
        }

        const usuario = await pool.query(
            `
            INSERT INTO usuarios
                (nombre, correo, password, tipo_usuario, codigo_operario, zona_asignada, empresa_id, nit_empresa, activo)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
            RETURNING id, nombre, correo, tipo_usuario, zona_asignada, empresa_id, nit_empresa, activo
            `,
            [
                String(nombre).trim(),
                correoNormalizado,
                hashPassword(password),
                tipo_usuario,
                codigo_operario || null,
                zona_asignada || null,
                empresaId,
                nit_empresa || null
            ]
        );

        emitirEvento('usuario_creado', { usuario_id: usuario.rows[0].id });

        await notificarUsuarios(
            await idsPorRol('admin'),
            {
                tipo: 'admin',
                titulo: 'Nuevo usuario creado',
                mensaje: `${usuario.rows[0].nombre} (${usuario.rows[0].tipo_usuario}).`,
                referenciaTipo: 'usuario',
                referenciaId: usuario.rows[0].id
            }
        );

        res.status(201).json({
            ok: true,
            mensaje: 'Usuario creado correctamente.',
            usuario: usuario.rows[0]
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al crear el usuario.'
        });
    }
});

app.put('/api/admin/usuarios/:id', requiereAdmin, async (req, res) => {
    try {
        const usuarioId = Number(req.params.id);
        const {
            nombre,
            correo,
            tipo_usuario,
            codigo_operario,
            zona_asignada,
            nit_empresa
        } = req.body;
        const permitidos = ['ciudadano', 'operario', 'empresa'];

        if (!nombre || !correo || !permitidos.includes(tipo_usuario)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'Completa los datos obligatorios.'
            });
        }

        const actual = await pool.query(
            'SELECT tipo_usuario FROM usuarios WHERE id = $1 LIMIT 1',
            [usuarioId]
        );

        if (actual.rowCount === 0 || actual.rows[0].tipo_usuario === 'admin') {
            return res.status(403).json({
                ok: false,
                mensaje: 'Este usuario no se puede editar desde el panel.'
            });
        }

        if (tipo_usuario === 'operario' && (!codigo_operario || !zona_asignada)) {
            return res.status(400).json({
                ok: false,
                mensaje: 'El operario necesita código y localidad asignada.'
            });
        }

        if (tipo_usuario === 'empresa' && !nit_empresa) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La empresa necesita un NIT.'
            });
        }

        let empresaId = null;
        if (tipo_usuario === 'empresa') {
            const empresa = await pool.query(
                `
                INSERT INTO empresas (nombre, nit, correo)
                VALUES ($1, $2, $3)
                ON CONFLICT (nit) DO UPDATE
                SET nombre = EXCLUDED.nombre
                RETURNING id
                `,
                [String(nombre).trim(), String(nit_empresa).trim(), String(correo).trim().toLowerCase()]
            );
            empresaId = empresa.rows[0].id;
        }

        const usuario = await pool.query(
            `
            UPDATE usuarios
            SET nombre = $1,
                correo = $2,
                tipo_usuario = $3,
                codigo_operario = $4,
                zona_asignada = $5,
                empresa_id = $6,
                nit_empresa = $7
            WHERE id = $8
              AND tipo_usuario <> 'admin'
            RETURNING id, nombre, correo, tipo_usuario, codigo_operario, zona_asignada, empresa_id, nit_empresa, activo
            `,
            [
                String(nombre).trim(),
                String(correo).trim().toLowerCase(),
                tipo_usuario,
                tipo_usuario === 'operario' ? String(codigo_operario).trim() : null,
                tipo_usuario === 'operario' ? String(zona_asignada).trim() : null,
                empresaId,
                tipo_usuario === 'empresa' ? String(nit_empresa).trim() : null,
                usuarioId
            ]
        );

        emitirEvento('usuario_actualizado', { usuario_id: usuarioId });

        await notificarUsuarios(
            await idsPorRol('admin'),
            {
                tipo: 'admin',
                titulo: 'Usuario actualizado',
                mensaje: `Cambios en ${usuario.rows[0].nombre}.`,
                referenciaTipo: 'usuario',
                referenciaId: usuarioId
            }
        );

        res.json({
            ok: true,
            mensaje: 'Usuario actualizado correctamente.',
            usuario: usuario.rows[0]
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al actualizar el usuario.'
        });
    }
});

app.put('/api/admin/usuarios/:id/password', requiereAdmin, async (req, res) => {
    try {
        const usuarioId = Number(req.params.id);
        const password = String(req.body.password || '');

        if (password.length < 6) {
            return res.status(400).json({
                ok: false,
                mensaje: 'La contraseña debe tener mínimo 6 caracteres.'
            });
        }

        const usuario = await pool.query(
            `
            UPDATE usuarios
            SET password = $1
            WHERE id = $2
              AND tipo_usuario <> 'admin'
            RETURNING id, nombre
            `,
            [hashPassword(password), usuarioId]
        );

        if (usuario.rowCount === 0) {
            return res.status(404).json({
                ok: false,
                mensaje: 'Usuario no encontrado.'
            });
        }

        await pool.query(
            'DELETE FROM sesiones WHERE usuario_id = $1',
            [usuarioId]
        );

        res.json({
            ok: true,
            mensaje: 'Contraseña actualizada correctamente.'
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al actualizar la contraseña.'
        });
    }
});

app.patch('/api/admin/usuarios/:id/estado', requiereAdmin, async (req, res) => {
    try {
        const usuarioId = Number(req.params.id);
        const activo = Boolean(req.body.activo);

        if (usuarioId === req.usuarioAutenticado.id && !activo) {
            return res.status(400).json({
                ok: false,
                mensaje: 'No puedes desactivar tu propia cuenta.'
            });
        }

        const resultado = await pool.query(
            `
            UPDATE usuarios
            SET activo = $1
            WHERE id = $2
            RETURNING id, nombre, correo, tipo_usuario, activo
            `,
            [activo, usuarioId]
        );

        if (resultado.rowCount === 0) {
            return res.status(404).json({
                ok: false,
                mensaje: 'Usuario no encontrado.'
            });
        }

        if (!activo) {
            await pool.query(
                'DELETE FROM sesiones WHERE usuario_id = $1',
                [usuarioId]
            );
        }

        emitirEvento('usuario_actualizado', { usuario_id: usuarioId, activo });

        await notificarUsuarios(
            await idsPorRol('admin'),
            {
                tipo: 'admin',
                titulo: activo ? 'Usuario activado' : 'Usuario desactivado',
                mensaje: resultado.rows[0].nombre,
                referenciaTipo: 'usuario',
                referenciaId: usuarioId
            }
        );

        if (!activo) {
            await notificarUsuarios([usuarioId], {
                tipo: 'cuenta',
                titulo: 'Tu cuenta fue desactivada',
                mensaje: 'Contacta al administrador de RunTrash.'
            });
        }

        res.json({
            ok: true,
            mensaje: activo ? 'Usuario activado.' : 'Usuario desactivado.',
            usuario: resultado.rows[0]
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al actualizar el usuario.'
        });
    }
});

app.get('/api/configuracion/publica', async (_req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT clave, valor
            FROM configuracion_sistema
            WHERE clave IN (
                'limite_reportes_diarios',
                'limite_ruta',
                'distancia_gps_maxima'
            )
        `);
        const configuracion = Object.fromEntries(
            resultado.rows.map((row) => [row.clave, Number(row.valor)])
        );
        res.json({
            ok: true,
            configuracion
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al cargar la configuración.'
        });
    }
});

app.get('/api/admin/configuracion', requiereAdmin, async (_req, res) => {
    try {
        const resultado = await pool.query(`
            SELECT clave, valor, actualizado_at
            FROM configuracion_sistema
            ORDER BY clave
        `);
        res.json({
            ok: true,
            configuracion: resultado.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al cargar la configuración.'
        });
    }
});

app.put('/api/admin/configuracion', requiereAdmin, async (req, res) => {
    try {
        const permitidas = {
            limite_reportes_diarios: [1, 20],
            limite_ruta: [1, 50],
            retencion_dias: [1, 365],
            distancia_gps_maxima: [5, 100]
        };
        const incoming = req.body || {};

        for (const [clave, valor] of Object.entries(incoming)) {
            if (!permitidas[clave]) continue;
            const numero = Number(valor);
            const [minimo, maximo] = permitidas[clave];
            if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
                return res.status(400).json({
                    ok: false,
                    mensaje: `El valor de ${clave} está fuera del rango permitido.`
                });
            }
            await pool.query(
                `
                INSERT INTO configuracion_sistema (clave, valor, actualizado_por, actualizado_at)
                VALUES ($1,$2,$3,NOW())
                ON CONFLICT (clave) DO UPDATE
                SET valor = EXCLUDED.valor,
                    actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_at = NOW()
                `,
                [clave, String(numero), req.usuarioAutenticado.id]
            );
        }

        emitirEvento('configuracion_actualizada');
        const resultado = await pool.query(`
            SELECT clave, valor, actualizado_at
            FROM configuracion_sistema
            ORDER BY clave
        `);
        res.json({
            ok: true,
            mensaje: 'Configuración actualizada.',
            configuracion: resultado.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            ok: false,
            mensaje: 'Error al guardar la configuración.'
        });
    }
});

/*
=========================================================
ERRORES
=========================================================
*/

app.use(
    (error, _req, res, _next) => {

        console.error(
            'ERROR DEL SERVIDOR:',
            error
        );

        const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
        const mensaje = error.code === 'LIMIT_FILE_SIZE'
            ? `La imagen supera el límite de ${MAX_UPLOAD_MB} MB.`
            : status === 500
                ? 'Error interno del servidor.'
                : error.message;

        res.status(status).json({
            ok: false,
            mensaje,
            // Se expone el detalle solo si se pide explicitamente,
            // para poder diagnosticar fallos en produccion sin
            // filtrar informacion sensible por defecto.
            ...(process.env.DIAGNOSTICO_DETALLE === 'true'
                ? { detalle: error.message, codigo: error.code || null }
                : {})
        });
    }
);

/*
=========================================================
FRONTEND EN EL MISMO SERVICIO (opcional)
=========================================================
Para desplegar todo junto en un solo dominio (un solo servicio
gratuito y una sola URL), define FRONTEND_DIR con la ruta de la
carpeta que contiene los .html.

Solo se exponen los archivos de una lista blanca. Nunca se
sirven .env, server.js, scripts, migraciones ni node_modules.
*/

const frontendDir = String(process.env.FRONTEND_DIR || '').trim()
    ? path.resolve(process.env.FRONTEND_DIR)
    : null;

const ARCHIVOS_PUBLICOS = [
    'index.html',
    'ciudadano.html',
    'empresa.html',
    'operario.html',
    'admin.html',
    'styles.css',
    'ui.js',
    'features.js',
    'config.js'
];

const CARPETAS_PUBLICAS = ['logos'];

if (frontendDir && fs.existsSync(frontendDir)) {
    app.get('/', (_req, res) => {
        res.sendFile(path.join(frontendDir, 'index.html'));
    });

    for (const archivo of ARCHIVOS_PUBLICOS) {
        app.get(`/${archivo}`, (_req, res) => {
            const destino = path.join(frontendDir, archivo);
            if (!fs.existsSync(destino)) {
                return res.status(404).type('text/plain').send('Archivo no disponible.');
            }
            res.sendFile(destino);
        });
    }

    for (const carpeta of CARPETAS_PUBLICAS) {
        app.use(
            `/${carpeta}`,
            express.static(path.join(frontendDir, carpeta), {
                index: false,
                dotfiles: 'deny',
                maxAge: '7d'
            })
        );
    }

    console.log(`Frontend servido desde ${frontendDir}`);
}

app.use((_req, res) => {
    res.status(404).json({
        ok: false,
        mensaje: 'Ruta no encontrada.'
    });
});

async function iniciarServidor() {
    await inicializarAdministrador();
    await limpiarSesionesExpiradas();
    await purgarReportesRetirados();

    const servidor = app.listen(PORT, () => {
        const info = almacen.resumen();
        console.log('========================================');
        console.log(`RunTrash API ejecutándose en http://localhost:${PORT}`);
        console.log(`Imágenes: almacenamiento ${info.modo}`
            + (info.modo === 's3'
                ? ` (bucket ${info.bucket} en ${info.region})`
                : ' (disco local, se pierden al redesplegar)'));
        console.log('========================================');
    });

    const intervaloRetencion = setInterval(purgarReportesRetirados, 24 * 60 * 60 * 1000);
    intervaloRetencion.unref();

    const cerrar = async (signal) => {
        console.log(`${signal}: cerrando RunTrash API...`);
        clearInterval(intervaloRetencion);
        servidor.close(async () => {
            await pool.end();
            process.exit(0);
        });
    };

    process.once('SIGINT', () => cerrar('SIGINT'));
    process.once('SIGTERM', () => cerrar('SIGTERM'));
}

if (require.main === module) {
    iniciarServidor().catch((error) => {
        console.error('No se pudo iniciar RunTrash API:', error.message);
        pool.end().finally(() => process.exit(1));
    });
}

module.exports = app;