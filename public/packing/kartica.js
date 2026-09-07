/* [2026-09-07 Dejan] SKUPNI IZRIS KARTICE NAROČILA.
 *
 * Prej je izris živel samo v public/packing/index.html. Ko je bilo treba enake
 * kartice pokazati še na /spakirani-paketi, je bila izbira: prepisati kodo (in
 * tvegati, da se strani sčasoma razideta) ali jo izločiti sem. Izločena je.
 * Če popravljaš videz ali vsebino kartice, popravi SAMO to datoteko.
 *
 * Stanje, ki je na vsaki strani drugačno (izbrana naročila, spakirana, nova),
 * pride prek window.KARTICA kot DOSTOPNE FUNKCIJE, ne kot vrednosti — index.html
 * spremenljivki packedOrders in newOrderIds med delovanjem prepiše, zato bi
 * enkraten prepis vrednosti tu obtičal na starem stanju.
 *
 * Stran mora ponuditi tudi funkcije, ki jih kličejo gumbi na kartici:
 * toggleOrderSelect(id), unpackOrder(id), saveNote(id).
 */
window.KARTICA = window.KARTICA || {};
const _izbrani   = () => (window.KARTICA.izbrani   ? window.KARTICA.izbrani()   : new Set());
const _spakirani = () => (window.KARTICA.spakirani ? window.KARTICA.spakirani() : {});
const _novi      = () => (window.KARTICA.novi      ? window.KARTICA.novi()      : new Set());

        const toEurRates = { 'EUR': 1, 'CZK': 0.04, 'PLN': 0.23, 'HUF': 0.0025, 'RON': 0.20 };
        const currencySymbols = { 'EUR': '€', 'CZK': 'Kč', 'PLN': 'zł', 'HUF': 'Ft', 'RON': 'lei' };
        const countryFlags = {
            'Croatia': '🇭🇷', 'Czech Republic': '🇨🇿', 'Poland': '🇵🇱',
            'Slovakia': '🇸🇰', 'Hungary': '🇭🇺', 'Greece': '🇬🇷', 'Italy': '🇮🇹', 'Slovenia': '🇸🇮', 'Romania': '🇷🇴', 'Germany': '🇩🇪',
            'English': '🇬🇧'
        };

        const colorHex = {
            'Črna': '#1a1a1a', 'Modra': '#3b82f6', 'Bela': '#ffffff', 'Siva': '#6b7280',
            'Rdeča': '#ef4444', 'Zelena': '#22c55e', 'Rjava': '#92400e', 'Bež': '#d4c5a9',
            'Roza': '#ec4899', 'Oranžna': '#f97316', 'Vijolična': '#8b5cf6', 'Rumena': '#eab308',
            'Turkizna': '#06b6d4', 'Temno modra': '#1e3a8a', 'Svetlo modra': '#93c5fd',
            'Tamnoplava': '#1e3a8a', 'Temnomodra': '#1e3a8a', 'Svetlomodra': '#93c5fd', 'Smeđa': '#92400e', 'Rjava': '#92400e', 'Bež': '#d4c5a9',
            'Črna & Bela': '#1a1a1a'
        };

        function getNote(orderId) {
            const entry = (window._packingNotes || {})[orderId];
            if (!entry) return "";
            // backend stores { note, updatedAt }, but old localStorage migration may put plain string
            return (typeof entry === "string") ? entry : (entry.note || "");
        }

        const MK_ORDER_URL = (mkId) => 'https://main.metakocka.si/apps/ordermanagement/orders/all/' + encodeURIComponent(mkId);

        function orderLinks(o) {
            // [2026-08-26 Dejan] Povezavi kazemo pri VSEH narocilih, ne le pri novih.
            const shop = (o.eshopUrl || o._eshop || o.eshop || '').trim();
            const wc = (o.wcId || '').trim();
            const mk = (o.mkId || '').trim();
            let h = '';
            if (shop && wc) {
                h += '<a class="src-link src-wc" target="_blank" rel="noopener" href="https://' + shop +
                     '/wp-admin/admin.php?page=wc-orders&action=edit&id=' + encodeURIComponent(wc) +
                     '" title="Odpri narocilo v WooCommerce">🛒 WooCommerce</a>';
            }
            if (mk) {
                h += '<a class="src-link src-mk" target="_blank" rel="noopener" href="' + MK_ORDER_URL(mk) +
                     '" title="Odpri narocilo v Metakocki">📘 Metakocka</a>';
            }
            return h ? '<div class="src-links no-print">' + h + '</div>' : '';
        }

        function renderOrderCard(order, isPacked) {
            const isSelected = _izbrani().has(order.id);
            const packedInfo = _spakirani()[order.id];
            
            // Check for warnings in any item
            const allWarnings = [];
            (order.products || order.items).forEach(product => {
                const items = product.items || (Array.isArray(product) ? product : [product]);
                items.forEach(item => {
                    if (item.warnings) allWarnings.push(...item.warnings);
                });
            });
            const hasWarnings = allWarnings.length > 0;
            
            return `
                <div class="order-card ${_novi().has(order.id) ? 'new-order' : ''} ${isPacked ? 'packed' : ''} ${isSelected ? 'selected' : ''} ${hasWarnings ? 'has-warnings' : ''} ${getNote(order.id) ? 'ima-opombo' : ''}" data-country="${order.country}" data-order-id="${order.id}">
                    ${hasWarnings ? `<div class="order-warning-banner">⚠️ OPOZORILO: ${allWarnings.length} težav — preverite ročno!</div>` : ''}
                    ${!isPacked ? `<input type="checkbox" class="order-select no-print" data-order-id="${order.id}" ${isSelected ? 'checked' : ''} onclick="toggleOrderSelect('${order.id}')">` : ''}
                    <div class="order-header">
                        <div>
                            <div class="customer-name">
                                ${order.customer}
                                ${_novi().has(order.id) ? '<span class="new-badge">NOV</span>' : ''}
                                ${isPacked ? '<span class="packed-badge">✅ SPAKIRANO</span>' : ''}
                                ${order.isExchange ? '<span class="exchange-badge">🔁 MENJAVA</span>' : ''}
                            </div>
                            <div class="order-price">
                                ${parseFloat(order.total || 0).toFixed(2)} ${currencySymbols[order.currency] || order.currency}
                                ${order.currency !== 'EUR' ? `<span class="order-price-eur">≈ ${(parseFloat(order.total || 0) * (toEurRates[order.currency] || 1)).toFixed(2)} €</span>` : ''}
                            </div>
                        </div>
                        <div class="order-meta">
                            <div class="order-id">#${order.id}</div>
                            <div>📥 ${order.orderDate} ${order.orderTime ? `<strong>${order.orderTime}</strong>` : ''}</div>
                            ${order.shippedDate ? `<div>📦 ${order.shippedDate}</div>` : ''}
                            <div>${countryFlags[order.country] || ''} ${order.country || ''}</div>
                            ${isPacked && packedInfo ? `<div style="color:#10b981; margin-top:3px;">Spakirano: ${new Date(packedInfo.packedAt).toLocaleTimeString('sl-SI', {hour:'2-digit',minute:'2-digit'})}</div>` : ''}
                            ${isPacked ? `<button class="btn btn-secondary no-print" onclick="unpackOrder('${order.id}')" style="font-size:10px; padding:2px 8px; margin-top:3px;">↩ Vrni</button>` : ''}
                            ${orderLinks(order)}
                        </div>
                    </div>
                    <ul class="items-list">
                        ${(order.products || order.items).map(product => {
                        // [2026-08-26 Dejan] Oznako (FIT/ZIP) izracunamo TUDI tukaj, ne samo
                        // ob razclembi na strezniku — starejsa narocila v predpomnilniku so
                        // bila razclenjena pred to spremembo in oznake nimajo shranjene.
                        const _sifra = String(product.code || product.label || '');
                        const oznakaZa = /KOMPSFIT|FIT.?KOMPRES/i.test(_sifra) ? 'FIT'
                                       : /KOMZIPS/i.test(_sifra) ? 'ZIP' : '';
                            const rawItems = (product.items || (Array.isArray(product) ? product : [product])).slice().sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.color || '').localeCompare(b.color || ''));
                            const grouped = [];
                            rawItems.forEach(item => {
                                const key = `${item.type}|${item.color}|${item.size}`;
                                const existing = grouped.find(g => g.key === key);
                                if (existing) { existing.count++; }
                                else { grouped.push({ ...item, key, count: 1 }); }
                            });
                            const label = product.label || '';
                            return (label ? `<li class="product-label">${label}</li>` : '') +
                                grouped.map(item => {
                                    const hasWarning = item.warnings && item.warnings.length > 0;
                                    return `
                                <li class="item ${hasWarning ? 'item-warning' : ''}">
                                    <input type="checkbox" class="item-checkbox">
                                    ${item.color ? `<div class="item-color" style="background: ${colorHex[item.color] || item.colorHex || '#ccc'}; ${item.color === 'Bela' ? 'border-color: #ccc;' : ''}"></div>` : ''}
                                    <span class="item-name">${(item.oznaka || oznakaZa) ? '<b class="oznaka">' + (item.oznaka || oznakaZa) + '</b> ' : ''}${(item.count || 1) + 'x '}${item.color ? item.color + ' ' : ''}${item.type}</span>
                                    <span class="item-size">${item.size}</span>
                                    ${hasWarning ? `<span class="item-warning-badge" title="${item.warnings.join('; ')}">⚠️</span>` : ''}
                                </li>
                            `}).join('');
                        }).join('')}
                    </ul>
                    <div class="no-print" style="margin-top:6px; display:flex; gap:4px;"><input type="text" class="order-note-input" data-order-id="${order.id}" placeholder="Opomba..." value="${getNote(order.id)}" style="flex:1; padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px;" onkeydown="if(event.key==='Enter')saveNote('${order.id}')"><button onclick="saveNote('${order.id}')" style="padding:4px 10px; background:#10b981; color:#fff; border:none; border-radius:4px; font-size:11px; cursor:pointer;">&#x1F4BE;</button></div>
                </div>
            `;
        }

