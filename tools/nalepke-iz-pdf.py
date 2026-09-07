#!/usr/bin/env python3
"""Iz Metakockinega PDF-ja z nalepkami izlusci zaporedje narocil.

Uporaba:  python3 nalepke-iz-pdf.py nalepke.pdf > nalepke.json

Zakaj lastni razclenjevalnik: na Macu ni pdftotext ne pypdf. PDF ima podpisano
pisavo z zamaknjenimi kodami znakov — znak = koda + 29 (presledek=3, 'A'=36).
Naglaseni znaki se tako ne dekodirajo (postanejo '?'), kar za nas ni vazno:
rabimo sifre in stevilke, ki so ASCII. Ujemanje po imenu zato normaliziramo
tako, da tudi na nasi strani nenavadne znake zamenjamo z '?'.

POZOR: vrstni red strani je treba vzeti iz drevesa /Kids, NE iz vrstnega reda
streamov v datoteki — ta je premesan in daje videz, da nalepke niso urejene.
"""
import re, zlib, json, sys

def naloziStrani(pot):
    raw = open(pot, 'rb').read()
    obj = {}
    for m in re.finditer(rb'(\d+)\s+0\s+obj\b(.*?)\bendobj', raw, re.S):
        obj[int(m.group(1))] = m.group(2)
    def kids(num, videni=None):
        if videni is None: videni = set()
        if num in videni: return []
        videni.add(num)
        b = obj.get(num, b'')
        if b'/Type' in b and b'/Page' in b and b'/Kids' not in b: return [num]
        m = re.search(rb'/Kids\s*\[(.*?)\]', b, re.S)
        if not m: return []
        out = []
        for r in re.finditer(rb'(\d+)\s+0\s+R', m.group(1)): out += kids(int(r.group(1)), videni)
        return out
    strani = []
    for k in sorted(n for n, b in obj.items() if b'/Type' in b and b'/Pages' in b and b'/Kids' in b):
        s = kids(k)
        if len(s) > len(strani): strani = s
    return obj, strani

def odkodiraj(b):
    out = []
    for i in range(0, len(b) - 1, 2):
        g = (b[i] << 8) | b[i+1]
        out.append(chr(g + 29) if 3 <= g <= 97 else '?')
    return ''.join(out)

def besedilo(obj, pnum):
    b = obj.get(pnum, b'')
    ids = [int(x) for x in re.findall(rb'/Contents\s+(\d+)\s+0\s+R', b)]
    if not ids:
        m = re.search(rb'/Contents\s*\[(.*?)\]', b, re.S)
        if m: ids = [int(x) for x in re.findall(rb'(\d+)\s+0\s+R', m.group(1))]
    besede = []
    for i in ids:
        m = re.search(rb'stream\r?\n(.*?)\r?\nendstream', obj.get(i, b''), re.S)
        if not m: continue
        try: d = zlib.decompress(m.group(1))
        except Exception: continue
        for k in re.findall(rb'\((?:\\.|[^()\\])*\)', d):
            besede.append(odkodiraj(k[1:-1].replace(b'\\(', b'(').replace(b'\\)', b')').replace(b'\\\\', b'\\')))
    return besede

def main():
    if len(sys.argv) < 2:
        print('uporaba: nalepke-iz-pdf.py nalepke.pdf', file=sys.stderr); sys.exit(1)
    obj, strani = naloziStrani(sys.argv[1])
    out = []
    for pi, pnum in enumerate(strani, 1):
        t = besedilo(obj, pnum)
        izd = [x for x in t if re.match(r'^\s*\d+\s*-\s*[A-Z0-9]', x)]
        prej = ''
        for i, x in enumerate(t):
            if x.startswith('C?mzett') or x.startswith('Cimzett') or x.startswith('Prejemnik') or x.startswith('Primatelj'):
                if i + 1 < len(t): prej = t[i+1]
                break
        if izd: out.append({'stran': pi, 'izdelki': izd[0], 'stranka': prej})
    print(json.dumps(out, ensure_ascii=False, indent=1), file=sys.stdout)
    print('nalepk: %d (strani v PDF: %d)' % (len(out), len(strani)), file=sys.stderr)

main()
