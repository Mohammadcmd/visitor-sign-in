"""Name, company and NFC tag normalization. Same rules as web/js/match.js and
apps-script/Code.gs, so every part of the system agrees on who matches whom."""
import re
import unicodedata

COMPANY_STOP = {'INC', 'LLC', 'LTD', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'THE',
                'GROUP', 'LP', 'PLC', 'GMBH', 'AND', 'OF', 'NA'}


def name_key(s):
    """Uppercase, strip accents, keep A-Z/0-9 as space-separated tokens, drop one-letter tokens."""
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if not unicodedata.combining(c)).upper()
    tokens = re.sub(r'[^A-Z0-9]+', ' ', s).split()
    return ' '.join(t for t in tokens if len(t) > 1)


def company_words(s):
    return [w for w in name_key(s).split() if w not in COMPANY_STOP]


def near(a, b):
    """Equal, or both at least 5 characters and one edit apart."""
    if a == b:
        return True
    if not a or not b or len(a) < 5 or len(b) < 5 or abs(len(a) - len(b)) > 1:
        return False
    i = j = edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) > len(b):
            i += 1
        elif len(b) > len(a):
            j += 1
        else:
            i += 1
            j += 1
    return edits + (len(a) - i) + (len(b) - j) <= 1


def same_company(a, b):
    if not a and not b:
        return True
    return any(len(x) >= 3 and any(len(y) >= 3 and near(x, y) for y in b) for x in a)


def normalize_tag(s):
    """Uppercase A-Z/0-9 only; collapse readers that send the number twice."""
    t = re.sub(r'[^A-Z0-9]', '', str(s or '').upper())
    if len(t) >= 8 and len(t) % 2 == 0 and t[:len(t) // 2] == t[len(t) // 2:]:
        t = t[:len(t) // 2]
    return t
