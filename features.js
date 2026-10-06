(() => {
    "use strict";

    const RunTrashFeatures = {
        localidades: [
            "Usaquén", "Suba", "Kennedy", "Engativá", "Fontibón",
            "Los Alpes", "Chapinero", "Teusaquillo", "La Candelaria",
            "San Cristóbal", "Santa Fe", "San Andrés", "Sumapaz",
            "Usura", "Rafael Uribe", "Tunjuel", "Bosa",
            "Ciudad Bolívar", "Puente Aranda"
        ],

        escapeHTML(value) {
            return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#039;");
        },

        escapeCSV(value) {
            let text = String(value ?? "");

            if (/^[=+\-@]/.test(text)) {
                text = `'${text}`;
            }

            return `"${text.replaceAll('"', '""')}"`;
        },

        downloadCSV(filename, headers, rows) {
            const headerLine = headers.map(this.escapeCSV).join(",");
            const body = rows
                .map((row) => row.map(this.escapeCSV).join(","))
                .join("\r\n");
            const blob = new Blob(
                ["\uFEFF", headerLine, "\r\n", body],
                { type: "text/csv;charset=utf-8" }
            );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");

            link.href = url;
            link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        printPDF({ title, subtitle = "", headers = [], rows = [], summary = [] }) {
            const printWindow = window.open("", "_blank", "width=1050,height=780");

            if (!printWindow) {
                throw new Error("El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes e inténtalo de nuevo.");
            }

            const summaryHTML = summary.length
                ? `<div class="summary">${summary.map((item) => `
                    <div class="summary-card">
                        <span>${this.escapeHTML(item.label)}</span>
                        <strong>${this.escapeHTML(item.value)}</strong>
                    </div>
                `).join("")}</div>`
                : "";

            const tableHTML = headers.length
                ? `<table>
                    <thead><tr>${headers.map((header) => `<th>${this.escapeHTML(header)}</th>`).join("")}</tr></thead>
                    <tbody>${rows.map((row) => `
                        <tr>${row.map((cell) => `<td>${this.escapeHTML(cell)}</td>`).join("")}</tr>
                    `).join("")}</tbody>
                </table>`
                : `<p class="empty">No hay datos para exportar.</p>`;

            printWindow.document.write(`
                <!doctype html>
                <html lang="es">
                <head>
                    <meta charset="utf-8">
                    <title>${this.escapeHTML(title)}</title>
                    <style>
                        *{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17241d;margin:38px}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0a9552;padding-bottom:18px;margin-bottom:24px}h1{margin:0 0 7px;color:#07542f;font-size:25px}p{margin:0;color:#66756d;font-size:13px}.brand{color:#0a9552;font-weight:800}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px}.summary-card{background:#f0fcf4;border:1px solid #d5f1df;border-radius:10px;padding:12px}.summary-card span,.summary-card strong{display:block}.summary-card span{color:#66756d;font-size:11px;margin-bottom:5px}.summary-card strong{font-size:20px}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#07542f;color:#fff;text-align:left;padding:10px}td{padding:9px 10px;border-bottom:1px solid #e3ebe6;vertical-align:top}tr:nth-child(even) td{background:#f8fbf9}.empty{padding:40px;text-align:center;background:#f4f7f5;border-radius:10px}@media print{body{margin:18px}.no-print{display:none}}
                    </style>
                </head>
                <body>
                    <header><div><h1>${this.escapeHTML(title)}</h1><p>${this.escapeHTML(subtitle)}</p></div><span class="brand">RUNTRASH</span></header>
                    ${summaryHTML}
                    ${tableHTML}
                    <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script>
                </body>
                </html>
            `);
            printWindow.document.close();
        },

        haversine(a, b) {
            const earthRadius = 6371;
            const toRadians = (degrees) => degrees * Math.PI / 180;
            const lat1 = toRadians(Number(a.latitud));
            const lon1 = toRadians(Number(a.longitud));
            const lat2 = toRadians(Number(b.latitud));
            const lon2 = toRadians(Number(b.longitud));
            const deltaLat = lat2 - lat1;
            const deltaLon = lon2 - lon1;
            const value = Math.sin(deltaLat / 2) ** 2
                + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

            return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
        },

        optimizeRoute(reports, limit = 15) {
            const validReports = reports
                .filter((report) => report.latitud !== null && report.latitud !== "" && report.longitud !== null && report.longitud !== "")
                .slice(0, limit);

            if (validReports.length <= 2) return validReports;

            const pending = [...validReports];
            const ordered = [pending.shift()];

            while (pending.length) {
                const current = ordered[ordered.length - 1];
                let nearestIndex = 0;
                let nearestDistance = Number.POSITIVE_INFINITY;

                pending.forEach((candidate, index) => {
                    const distance = this.haversine(current, candidate);
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        nearestIndex = index;
                    }
                });

                ordered.push(pending.splice(nearestIndex, 1)[0]);
            }

            return ordered;
        },

        routeDistance(reports) {
            if (reports.length < 2) return 0;
            return reports.slice(1).reduce(
                (total, report, index) => total + this.haversine(reports[index], report),
                0
            );
        },

        buildDirectionsURL(reports) {
            if (!reports.length) return "https://www.google.com/maps";

            if (reports.length === 1) {
                return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${reports[0].latitud},${reports[0].longitud}`)}`;
            }

            const destination = reports[reports.length - 1];
            const waypoints = reports
                .slice(0, -1)
                .map((report) => `${report.latitud},${report.longitud}`)
                .join("|");

            return `https://www.google.com/maps/dir/?api=1`
                + `&destination=${encodeURIComponent(`${destination.latitud},${destination.longitud}`)}`
                + `&waypoints=${encodeURIComponent(waypoints)}`
                + "&travelmode=driving";
        },

        buildMapURL(reports) {
            if (!reports.length) return "https://www.google.com/maps";

            if (reports.length === 1) {
                return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${reports[0].latitud},${reports[0].longitud}`)}`;
            }

            const center = reports[Math.floor(reports.length / 2)];
            return `https://www.google.com/maps/search/?api=1`
                + `&query=${encodeURIComponent(`${center.latitud},${center.longitud}`)}`
                + `&zoom=13`;
        },

        buildWazeURL(report) {
            if (!report?.latitud || !report?.longitud) return "";
            return `https://waze.com/ul?ll=${encodeURIComponent(`${report.latitud},${report.longitud}`)}&navigate=yes&zoom=17`;
        },

        mapEmbedURL(reports) {
            if (!reports.length) return "";

            const first = reports[0];
            return `https://maps.google.com/maps?q=${encodeURIComponent(`${first.latitud},${first.longitud}`)}&z=14&output=embed`;
        },

        sectorFor(report) {
            const explicitSector = report.localidad || report.sector || report.zona_asignada;
            if (explicitSector) return String(explicitSector).trim();

            const location = String(report.ubicacion || "").trim();
            if (!location) return "Sin sector";
            if (/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(location)) return "Por geolocalizar";

            return location.split(/\s*[,\-–]\s*/)[0] || "Sin sector";
        },

        reportsBySector(reports, days = 15) {
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            const grouped = new Map();

            reports.forEach((report) => {
                const reportDate = new Date(report.fecha).getTime();
                if (Number.isFinite(reportDate) && reportDate < cutoff) return;

                const sector = this.sectorFor(report);
                if (!grouped.has(sector)) {
                    grouped.set(sector, {
                        sector,
                        total: 0,
                        pendientes: 0,
                        enProceso: 0,
                        completados: 0
                    });
                }

                const item = grouped.get(sector);
                item.total += 1;
                if (report.estado === "pendiente") item.pendientes += 1;
                if (report.estado === "en proceso") item.enProceso += 1;
                if (report.estado === "completado") item.completados += 1;
            });

            const result = [...grouped.values()].sort((a, b) => b.total - a.total);
            const maximum = result[0]?.total || 1;
            return result.map((item) => ({ ...item, percentage: Math.round(item.total / maximum * 100) }));
        },

        relativeTime(dateValue) {
            if (!dateValue) return "";
            const seconds = Math.round((new Date(dateValue).getTime() - Date.now()) / 1000);
            const formatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
            const ranges = [
                [60, "second"],
                [60, "minute"],
                [24, "hour"],
                [7, "day"],
                [4.345, "week"],
                [12, "month"],
                [Number.POSITIVE_INFINITY, "year"]
            ];
            let duration = seconds;

            for (const [amount, unit] of ranges) {
                if (Math.abs(duration) < amount) {
                    return formatter.format(Math.round(duration), unit);
                }
                duration /= amount;
            }

            return "";
        },

        async apiFetch(input, options = {}) {
            const headers = new Headers(options.headers || {});
            const token = localStorage.getItem("runtrash_token");
            if (token) headers.set("Authorization", `Bearer ${token}`);

            if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
                headers.set("Content-Type", "application/json");
            }

            const response = await fetch(input, { ...options, headers });
            if (response.status === 401) {
                localStorage.removeItem("runtrash_token");
                localStorage.removeItem("runtrash_user");
                if (!location.pathname.endsWith("index.html")) location.href = "index.html";
                throw new Error("Tu sesión expiró. Inicia sesión nuevamente.");
            }
            return response;
        },

        connectEvents(apiBase, onEvent, onStatus) {
            if (!("EventSource" in window)) return () => {};

            const token = localStorage.getItem("runtrash_token");
            const separator = apiBase.includes("?") ? "&" : "?";
            const source = new EventSource(`${apiBase}/api/eventos${separator}token=${encodeURIComponent(token || "")}`);
            source.onopen = () => onStatus?.("conectado");
            source.onerror = () => onStatus?.("reconectando");
            source.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.tipo !== "conectado") onEvent?.(data);
                } catch (error) {
                    console.warn("Evento inválido:", error);
                }
            };

            return () => source.close();
        },

        async requestNotificationPermission() {
            if (!("Notification" in window)) {
                throw new Error("Este navegador no admite notificaciones.");
            }

            if (Notification.permission === "granted") return "granted";

            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
                throw new Error("El permiso de notificaciones no fue concedido.");
            }

            return permission;
        },

        notify(title, message) {
            if ("Notification" in window && Notification.permission === "granted") {
                const notificacion = new Notification(title, {
                    body: message,
                    icon: "logos/logo.png",
                    tag: `runtrash-${Date.now()}`
                });

                notificacion.addEventListener("click", () => {
                    window.focus();
                    notificacion.close();
                });
            }
        },

        permissionState() {
            if (!("Notification" in window)) return "no-soportado";
            return Notification.permission;
        },

        /*
        ==========================================================
        CENTRO DE NOTIFICACIONES
        ==========================================================
        */

        async cargarNotificaciones(apiBase) {
            const response = await this.apiFetch(`${apiBase}/api/notificaciones`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.mensaje || "No se pudieron cargar las notificaciones.");
            }

            return {
                notificaciones: data.notificaciones || [],
                noLeidas: Number(data.no_leidas || 0)
            };
        },

        async marcarNotificacionesLeidas(apiBase) {
            const response = await this.apiFetch(`${apiBase}/api/notificaciones/leidas`, {
                method: "POST"
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.mensaje || "No se pudieron marcar las notificaciones.");
            }

            return true;
        },

        iconoNotificacion(tipo) {
            const iconos = {
                reporte_nuevo: { clase: "pending", simbolo: "!" },
                asignacion: { clase: "progress", simbolo: "🧭" },
                estado: { clase: "done", simbolo: "✓" },
                admin: { clase: "info", simbolo: "⚙" },
                cuenta: { clase: "alert", simbolo: "!" }
            };

            return iconos[tipo] || { clase: "info", simbolo: "🔔" };
        },

        renderNotificaciones(contenedor, notificaciones, { alHacerClic } = {}) {
            if (!contenedor) return;

            if (!notificaciones.length) {
                contenedor.innerHTML = `
                    <div class="empty-state">
                        <span class="empty-state-icon">✓</span>
                        <strong>Sin novedades</strong>
                        <p>Aquí verás las alertas de tu cuenta.</p>
                    </div>`;
                return;
            }

            contenedor.innerHTML = `<div class="notification-list">${notificaciones.map((item) => {
                const icono = this.iconoNotificacion(item.tipo);
                const referencia = item.referencia_tipo === "reporte"
                    ? "reporte"
                    : item.referencia_tipo === "usuario"
                        ? "usuario"
                        : "";

                return `
                    <div class="notification-item ${item.leida ? "is-read" : "is-unread"}"
                         ${referencia ? `data-notificacion-tipo="${referencia}" data-notificacion-id="${item.referencia_id}"` : ""}
                         ${alHacerClic ? 'role="button" tabindex="0"' : ""}>
                        <span class="notification-item-icon ${icono.clase}" aria-hidden="true">${icono.simbolo}</span>
                        <div>
                            <strong>${this.escapeHTML(item.titulo)}</strong>
                            <p>${this.escapeHTML(item.mensaje)}</p>
                            <small>${this.relativeTime(item.fecha)}</small>
                        </div>
                    </div>`;
            }).join("")}</div>`;

            if (!alHacerClic) return;

            const abrir = (elemento) => {
                const tipo = elemento.dataset.notificacionTipo;
                const id = elemento.dataset.notificacionId;
                if (tipo && id) alHacerClic(tipo, Number(id), elemento);
            };

            contenedor.querySelectorAll("[data-notificacion-id]").forEach((elemento) => {
                elemento.addEventListener("click", () => abrir(elemento));
                elemento.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        abrir(elemento);
                    }
                });
            });
        },

        textoBotonAlertas() {
            const estado = this.permissionState();

            if (estado === "granted") return { texto: "🔔 Alertas activadas", activo: true };
            if (estado === "denied") return { texto: "🔕 Alertas bloqueadas", activo: false, bloqueado: true };

            return { texto: "🔔 Activar alertas", activo: false };
        }
    };

    window.RunTrashFeatures = RunTrashFeatures;
})();
