(() => {
    "use strict";

    const DESKTOP_BREAKPOINT = 820;

    function setSidebar(open) {
        const sidebar = document.querySelector("[data-sidebar]");
        const backdrop = document.querySelector("[data-sidebar-backdrop]");
        const toggle = document.querySelector("[data-sidebar-toggle]");

        if (!sidebar) return;

        sidebar.classList.toggle("is-open", open);
        document.body.classList.toggle("sidebar-open", open);
        backdrop?.classList.toggle("is-visible", open);
        toggle?.setAttribute("aria-expanded", String(open));

        if (open) {
            window.setTimeout(() => {
                sidebar.querySelector("[data-sidebar-close]")?.focus();
            }, 220);
        }
    }

    function closeVisibleModal() {
        const modal = document.querySelector(".modal.show, .modal.active");
        if (!modal) return false;

        const closeButton = modal.querySelector(".close, .close-modal");
        if (closeButton) {
            closeButton.click();
        } else {
            modal.classList.remove("show", "active");
        }
        return true;
    }

    function initializeSidebar() {
        const toggle = document.querySelector("[data-sidebar-toggle]");
        const closeButton = document.querySelector("[data-sidebar-close]");
        const backdrop = document.querySelector("[data-sidebar-backdrop]");
        const sidebar = document.querySelector("[data-sidebar]");

        if (!sidebar) return;

        toggle?.addEventListener("click", () => {
            setSidebar(!sidebar.classList.contains("is-open"));
        });

        closeButton?.addEventListener("click", () => setSidebar(false));
        backdrop?.addEventListener("click", () => setSidebar(false));

        sidebar.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => {
                if (window.innerWidth <= DESKTOP_BREAKPOINT) {
                    setSidebar(false);
                }
            });
        });

        window.addEventListener("resize", () => {
            if (window.innerWidth > DESKTOP_BREAKPOINT) {
                setSidebar(false);
            }
        });
    }

    function initializeModals() {
        document.querySelectorAll(".modal").forEach((modal) => {
            let lastFocusedElement = null;
            let wasOpen = modal.classList.contains("show") || modal.classList.contains("active");

            const updateModal = () => {
                const isOpen = modal.classList.contains("show") || modal.classList.contains("active");
                modal.setAttribute("aria-hidden", String(!isOpen));

                if (isOpen && !wasOpen) {
                    lastFocusedElement = document.activeElement;
                    document.body.classList.add("modal-open");
                    window.requestAnimationFrame(() => {
                        const firstField = modal.querySelector("input:not([type='hidden']), textarea, select");
                        (firstField || modal.querySelector(".close, .close-modal"))?.focus();
                    });
                } else if (!isOpen && wasOpen) {
                    document.body.classList.remove("modal-open");
                    if (lastFocusedElement instanceof HTMLElement) {
                        lastFocusedElement.focus();
                    }
                }

                wasOpen = isOpen;
            };

            new MutationObserver(updateModal).observe(modal, {
                attributes: true,
                attributeFilter: ["class"]
            });

            updateModal();
        });
    }

    function initializeDateLabels() {
        const formatter = new Intl.DateTimeFormat("es-CO", {
            weekday: "long",
            day: "numeric",
            month: "long"
        });

        document.querySelectorAll("[data-current-date]").forEach((element) => {
            const date = formatter.format(new Date());
            element.textContent = date.charAt(0).toUpperCase() + date.slice(1);
        });
    }

    function initializeLoginFeedback() {
        const form = document.getElementById("loginForm");
        const message = document.getElementById("mensajeLogin");

        if (!form || !message) return;

        form.addEventListener("input", () => {
            message.className = "mensaje";
            message.textContent = "";
        });
    }

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;

        if (document.body.classList.contains("sidebar-open")) {
            setSidebar(false);
            return;
        }

        closeVisibleModal();
    });

    document.addEventListener("DOMContentLoaded", () => {
        initializeSidebar();
        initializeModals();
        initializeDateLabels();
        initializeLoginFeedback();
    });
})();
