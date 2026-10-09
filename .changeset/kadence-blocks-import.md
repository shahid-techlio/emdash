---
"@emdash-cms/gutenberg-to-portable-text": minor
---

Adds conversion for Kadence Blocks, so WordPress imports keep content from sites built with Kadence instead of dropping it or keeping it as raw HTML.

Buttons, testimonials, tab titles, and accordion titles were previously lost because Kadence stores them in block attributes or renders them on the server. They now import as buttons, pullquotes with citations, and section headings. Row layouts import as columns, Kadence tables as tables, galleries as galleries, icon lists as bullet lists, and advanced headings, images, info boxes, count-ups, and spacers as their closest built-in blocks. Content saved by Kadence 2.x, which stored buttons, icon list items, and testimonials on the parent block, is converted as well.

Kadence styling and blocks that render site features rather than content, such as forms, post grids, and navigation, are not converted.
