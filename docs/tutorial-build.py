#!/usr/bin/env python3
"""Build tutorial PDFs from the editable Markdown files next to this script.

Requires Python 3 and reportlab. Example:
    python docs/tutorial-build.py
    python docs/tutorial-build.py --copy-to ./output/pdf

Windows uses installed Microsoft YaHei and Consolas when available. Elsewhere,
pass --regular-font, --bold-font and --mono-font paths to suitable TrueType
fonts. The first two must include Chinese glyphs. No fonts are redistributed.
"""
from __future__ import annotations

import argparse
from html import escape
from io import BytesIO
import os
from pathlib import Path
import re
import shutil

from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle

WIDTH, HEIGHT = 595.276, 841.89
MARGIN = 42
CONTENT = WIDTH - 2 * MARGIN
INK, MUTED = HexColor('#172c42'), HexColor('#51677e')
ACCENT, LINE = HexColor('#087e8b'), HexColor('#cfdae4')


def parse_markdown(path: Path):
    text = path.read_text(encoding='utf8')
    document_title = re.search(r'^# (.+)$', text, re.M).group(1)
    version = re.search(r'^Tabby Group Server Stats ([0-9.]+)$', text, re.M).group(1)
    chunks = re.split(r'<!-- PAGE: (\d+) -->', text)
    pages = []
    for index in range(1, len(chunks), 2):
        number, body = int(chunks[index]), chunks[index + 1]
        if number != len(pages) + 1:
            raise ValueError(f'{path.name}: nonsequential PAGE marker {number}')
        subtitle = re.search(r'<!-- subtitle: (.+?) -->', body).group(1)
        title = re.search(r'^## (.+)$', body, re.M).group(1)
        lines = body.splitlines()
        blocks, i = [], 0
        while i < len(lines):
            line = lines[i]
            if not line.strip() or line.startswith('<!--') or line.startswith('<a id=') or line.startswith('## '):
                i += 1
            elif line.startswith('```'):
                code = []
                i += 1
                while i < len(lines) and not lines[i].startswith('```'):
                    code.append(lines[i]); i += 1
                if i == len(lines):
                    raise ValueError(f'{path.name}: unterminated code block')
                blocks.append(('code', '\n'.join(code))); i += 1
            elif line.startswith('|'):
                rows = []
                while i < len(lines) and lines[i].startswith('|'):
                    cells = [cell.strip() for cell in lines[i].strip('|').split('|')]
                    if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                        rows.append(cells)
                    i += 1
                blocks.append(('table', rows))
            elif line.startswith('- ['):
                match = re.fullmatch(r'- \[(.+)\]\(#page-(\d+)\)', line)
                if not match:
                    raise ValueError(f'{path.name}: unsupported contents link {line}')
                blocks.append(('toc', (match.group(1), int(match.group(2))))); i += 1
            elif line.startswith('### '):
                blocks.append(('h', line[4:])); i += 1
            elif line.startswith('> '):
                blocks.append(('callout', line[2:])); i += 1
            else:
                paragraph = [line]
                i += 1
                while i < len(lines) and lines[i].strip():
                    paragraph.append(lines[i]); i += 1
                blocks.append(('p', ' '.join(paragraph)))
        pages.append((title, subtitle, blocks))
    return document_title, version, pages


def paragraph(pdf, text, y, lang, heading=False):
    style = ParagraphStyle('body', fontName='GuideBold' if heading else 'GuideRegular',
                           fontSize=12 if heading else 10.3, leading=17 if heading else 16,
                           textColor=INK, wordWrap='CJK' if lang == 'zh-CN' else None)
    item = Paragraph(escape(text), style)
    _, height = item.wrap(CONTENT, 1000)
    item.drawOn(pdf, MARGIN, y - height)
    return y - height - (9 if heading else 13)


def code_block(pdf, text, y):
    lines = text.splitlines()
    size = 8.6
    max_width = max(pdfmetrics.stringWidth(line, 'GuideMono', size) for line in lines)
    if max_width > CONTENT - 24:
        size = max(7.2, size * (CONTENT - 24) / max_width)
    leading = size * 1.42
    if max(pdfmetrics.stringWidth(line, 'GuideMono', size) for line in lines) > CONTENT - 22:
        raise ValueError('Code line too long; split the line in the Markdown source')
    height = len(lines) * leading + 22
    pdf.setFillColor(HexColor('#f1f5f8'))
    pdf.roundRect(MARGIN, y - height, CONTENT, height, 5, fill=1, stroke=0)
    pdf.setFillColor(INK)
    text_object = pdf.beginText(MARGIN + 12, y - 13 - size)
    text_object.setFont('GuideMono', size)
    text_object.setLeading(leading)
    for line in lines:
        text_object.textLine(line)
    pdf.drawText(text_object)
    return y - height - 13


def table_block(pdf, rows, y, lang):
    style = ParagraphStyle('table', fontName='GuideRegular', fontSize=9.3, leading=14,
                           textColor=INK, wordWrap='CJK' if lang == 'zh-CN' else None)
    data = [[Paragraph(escape(cell), style) for cell in row] for row in rows]
    widths = [CONTENT * .31, CONTENT * .69] if len(rows[0]) == 2 else [CONTENT * .4, CONTENT * .3, CONTENT * .3]
    item = Table(data, colWidths=widths, hAlign='LEFT')
    item.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#dfeef1')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBELOW', (0, 0), (-1, 0), .5, ACCENT),
        ('LINEBELOW', (0, 1), (-1, -1), .4, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ]))
    _, height = item.wrap(CONTENT, 1000)
    item.drawOn(pdf, MARGIN, y - height)
    return y - height - 15


def callout(pdf, text, y, lang):
    style = ParagraphStyle('callout', fontName='GuideRegular', fontSize=9.6, leading=15,
                           textColor=INK, wordWrap='CJK' if lang == 'zh-CN' else None)
    item = Paragraph(escape(text), style)
    _, height = item.wrap(CONTENT - 26, 1000)
    box_height = height + 22
    pdf.setFillColor(HexColor('#edf6f4'))
    pdf.roundRect(MARGIN, y - box_height, CONTENT, box_height, 5, fill=1, stroke=0)
    pdf.setFillColor(ACCENT)
    pdf.rect(MARGIN, y - box_height, 3, box_height, fill=1, stroke=0)
    item.drawOn(pdf, MARGIN + 13, y - 11 - height)
    return y - box_height - 14


def render(source: Path, lang: str):
    document_title, version, pages = parse_markdown(source)
    output = BytesIO()
    pdf = canvas.Canvas(output, pagesize=(WIDTH, HEIGHT), pageCompression=1)
    pdf.setTitle('Tabby Group Server Stats | ' + document_title)
    pdf.setAuthor('lishuainan0209')
    pdf.setSubject('Step-by-step user guide for version ' + version)
    bottoms = []
    for number, (title, subtitle, blocks) in enumerate(pages, 1):
        pdf.bookmarkPage(f'page-{number}')
        pdf.addOutlineEntry(f'{number}. {title}', f'page-{number}', 0, False)
        pdf.setFillColor(ACCENT); pdf.rect(0, HEIGHT - 9, WIDTH, 9, fill=1, stroke=0)
        pdf.setFont('GuideRegular', 8.5); pdf.setFillColor(MUTED)
        pdf.drawString(MARGIN, HEIGHT - 35, 'TABBY GROUP SERVER STATS / ' + version)
        title_size = 21 if lang == 'zh-CN' else 20
        if pdfmetrics.stringWidth(title, 'GuideBold', title_size) > CONTENT:
            title_size *= CONTENT / pdfmetrics.stringWidth(title, 'GuideBold', title_size)
        if title_size < 17:
            raise ValueError(f'{lang} page {number}: shorten the title')
        pdf.setFont('GuideBold', title_size); pdf.setFillColor(INK)
        pdf.drawString(MARGIN, HEIGHT - 74, title)
        pdf.setFont('GuideRegular', 10); pdf.setFillColor(ACCENT)
        if pdfmetrics.stringWidth(subtitle, 'GuideRegular', 10) > CONTENT:
            raise ValueError(f'{lang} page {number}: shorten the subtitle')
        pdf.drawString(MARGIN, HEIGHT - 97, subtitle)
        pdf.setStrokeColor(LINE); pdf.line(MARGIN, HEIGHT - 111, WIDTH - MARGIN, HEIGHT - 111)
        y = HEIGHT - 129
        for kind, value in blocks:
            if kind in ('p', 'h'):
                y = paragraph(pdf, value, y, lang, kind == 'h')
            elif kind == 'code':
                y = code_block(pdf, value, y)
            elif kind == 'table':
                y = table_block(pdf, value, y, lang)
            elif kind == 'callout':
                y = callout(pdf, value, y, lang)
            elif kind == 'toc':
                text, target = value
                if not 1 <= target <= len(pages):
                    raise ValueError(f'Invalid contents target {target}')
                pdf.setFillColor(ACCENT); pdf.setFont('GuideRegular', 10.1)
                pdf.drawString(MARGIN + 4, y - 12, text)
                pdf.drawRightString(WIDTH - MARGIN, y - 12, str(target))
                pdf.linkRect('', f'page-{target}', (MARGIN, y - 19, WIDTH - MARGIN, y + 1), relative=0, thickness=0)
                y -= 25
        bottoms.append(round(y, 1))
        if y < 51:
            raise ValueError(f'{lang} page {number} overflows (bottom {y:.1f}); shorten the Markdown page')
        pdf.setStrokeColor(LINE); pdf.line(MARGIN, 41, WIDTH - MARGIN, 41)
        pdf.setFont('GuideRegular', 8); pdf.setFillColor(MUTED)
        pdf.drawString(MARGIN, 26, 'lishuainan0209 · MIT · ' + ('使用手册' if lang == 'zh-CN' else 'User guide'))
        pdf.setFillColor(ACCENT)
        pdf.drawCentredString(WIDTH / 2, 26, '返回目录' if lang == 'zh-CN' else 'Contents')
        pdf.linkRect('', 'page-1', (WIDTH / 2 - 35, 19, WIDTH / 2 + 35, 37), relative=0, thickness=0)
        pdf.setFillColor(MUTED); pdf.drawRightString(WIDTH - MARGIN, 26, f'{number} / {len(pages)}')
        pdf.showPage()
    pdf.save()
    print(f'{source.name}: {len(pages)} pages; bottom positions {bottoms}')
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--docs-dir', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--copy-to', type=Path)
    fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    parser.add_argument('--regular-font', type=Path, default=fonts / 'msyh.ttc')
    parser.add_argument('--bold-font', type=Path, default=fonts / 'msyhbd.ttc')
    parser.add_argument('--mono-font', type=Path, default=fonts / 'consola.ttf')
    args = parser.parse_args()
    for name, path in [('GuideRegular', args.regular_font), ('GuideBold', args.bold_font), ('GuideMono', args.mono_font)]:
        if not path.is_file():
            parser.error(f'Font not found: {path}. Supply installed TrueType fonts using the font arguments.')
        pdfmetrics.registerFont(TTFont(name, str(path), subfontIndex=0))
    for name in ['GuideRegular', 'GuideBold']:
        if ord('中') not in pdfmetrics.getFont(name).face.charToGlyph:
            parser.error(f'{name} must contain Chinese glyphs')
    completed = []
    for lang in ['zh-CN', 'en']:
        source = args.docs_dir / f'tutorial.{lang}.md'
        completed.append((source.with_suffix('.pdf'), render(source, lang)))
    for dest, content in completed:
        dest.write_bytes(content)
        if args.copy_to:
            args.copy_to.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, args.copy_to / dest.name)
        print(f'Wrote {dest.name}: {len(content)} bytes')


if __name__ == '__main__':
    main()
