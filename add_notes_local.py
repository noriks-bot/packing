content = open('public/packing/index.html', 'r').read()

# 1. Add notes JS (localStorage) before refreshOrders
notes_js = '        // === ORDER NOTES (localStorage) ===\n'
notes_js += '        function getNote(orderId) {\n'
notes_js += '            try { return JSON.parse(localStorage.getItem("packing_notes") || "{}")[orderId] || ""; } catch(e) { return ""; }\n'
notes_js += '        }\n'
notes_js += '        function saveNote(orderId) {\n'
notes_js += '            const input = document.querySelector(\'.order-note-input[data-order-id="\' + orderId + \'"]\');\n'
notes_js += '            if (!input) return;\n'
notes_js += '            try {\n'
notes_js += '                const notes = JSON.parse(localStorage.getItem("packing_notes") || "{}");\n'
notes_js += '                if (input.value.trim()) notes[orderId] = input.value.trim();\n'
notes_js += '                else delete notes[orderId];\n'
notes_js += '                localStorage.setItem("packing_notes", JSON.stringify(notes));\n'
notes_js += '                input.style.borderColor = "#10b981";\n'
notes_js += '                setTimeout(function() { input.style.borderColor = "#ddd"; }, 1000);\n'
notes_js += '            } catch(e) {}\n'
notes_js += '        }\n\n'

content = content.replace('        async function refreshOrders() {', notes_js + '        async function refreshOrders() {')

# 2. Add notes input in card - before </ul>\n                </div>
old_end = '                    </ul>\n                </div>\n            `;'
new_end = '                    </ul>\n                    <div class="no-print" style="margin-top:6px; display:flex; gap:4px;"><input type="text" class="order-note-input" data-order-id="${order.id}" placeholder="Opomba..." value="${getNote(order.id)}" style="flex:1; padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px;" onkeydown="if(event.key===\'Enter\')saveNote(\'${order.id}\')"><button onclick="saveNote(\'${order.id}\')" style="padding:4px 10px; background:#10b981; color:#fff; border:none; border-radius:4px; font-size:11px; cursor:pointer;">&#x1F4BE;</button></div>\n                </div>\n            `;'

content = content.replace(old_end, new_end)

open('public/packing/index.html', 'w').write(content)
print('Done')
