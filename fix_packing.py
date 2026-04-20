import re

content = open('public/packing/index.html', 'r').read()

# Remove notes JS block
notes_js_start = '        // === ORDER NOTES ==='
notes_js_end = "            } catch(e) { alert(\"Napaka pri shranjevanju\"); }\n        }"
idx_start = content.find(notes_js_start)
idx_end = content.find(notes_js_end)
if idx_start >= 0 and idx_end >= 0:
    content = content[:idx_start] + content[idx_end + len(notes_js_end):]
    print('Removed notes JS')

# Fix startup
content = content.replace('loadNotes().catch(() => {}).then(() => refreshOrders());', 'refreshOrders();')
print('Fixed startup')

# Remove notes input div from card template
# Pattern: <div class="no-print" style="margin-top:6px; ... </div>
content = re.sub(r'\n\s*<div class="no-print" style="margin-top:6px;[^>]*>.*?</button>\s*\n\s*</div>', '', content, flags=re.DOTALL)
print('Removed notes input from cards')

open('public/packing/index.html', 'w').write(content)
print('Done')
