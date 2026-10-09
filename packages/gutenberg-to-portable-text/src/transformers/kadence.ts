/**
 * Transformers for Kadence Blocks (kadence/*)
 *
 * Kadence keeps content in three places: block attributes (buttons,
 * testimonials, tab titles), the saved markup (headings, list items, accordion
 * titles), and nowhere at all for layout blocks, which save no wrapper markup
 * and are rendered by PHP. Kadence 2.x stored buttons, icon list items and
 * testimonials as arrays on the parent block; those are read as well.
 */

import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

import {
	decodeUrlEntities,
	extractAlt,
	extractCaption,
	extractSrc,
	extractText,
} from "../inline.js";
import type {
	BlockTransformer,
	ConvertOptions,
	GutenbergBlock,
	PortableTextBlock,
	PortableTextButtonBlock,
	PortableTextGalleryBlock,
	PortableTextImageBlock,
	PortableTextTableBlock,
	PortableTextTextBlock,
	TransformContext,
} from "../types.js";
import { attrArray, attrBoolean, attrNumber, attrString, isRecord } from "../types.js";
import { sanitizeHref } from "../url.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextStyle = NonNullable<PortableTextTextBlock["style"]>;

const CLASS_SEPARATOR_PATTERN = /\s+/;
const HEADING_TAG_PATTERN = /^h([1-6])$/;
const THOUSANDS_PATTERN = /\B(?=(\d{3})+(?!\d))/g;
const HEADING_STYLES = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const SECTION_TITLE_STYLE: TextStyle = "h3";

function headingStyle(level: number | undefined, fallback: TextStyle = "h2"): TextStyle {
	return (level && HEADING_STYLES[level - 1]) || fallback;
}

function tagStyle(tag: string | undefined, fallback: TextStyle): TextStyle {
	const level = tag?.match(HEADING_TAG_PATTERN)?.[1];
	return level ? headingStyle(Number(level)) : fallback;
}

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function getAttribute(element: Element, name: string): string | undefined {
	return element.attrs.find((attr) => attr.name === name)?.value;
}

function hasClass(element: Element, className: string): boolean {
	return (getAttribute(element, "class") ?? "").split(CLASS_SEPARATOR_PATTERN).includes(className);
}

/** Elements matching `predicate`, in document order, without descending into matches */
function findElements(nodes: Node[], predicate: (element: Element) => boolean): Element[] {
	const found: Element[] = [];
	const stack = nodes.toReversed();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (!isElement(node)) continue;
		if (predicate(node)) {
			found.push(node);
			continue;
		}
		for (let i = node.childNodes.length - 1; i >= 0; i--) {
			stack.push(node.childNodes[i]!);
		}
	}
	return found;
}

function findByClass(nodes: Node[], className: string): Element | undefined {
	return findElements(nodes, (element) => hasClass(element, className))[0];
}

function findByTag(nodes: Node[], tagName: string): Element | undefined {
	return findElements(nodes, (element) => element.tagName === tagName)[0];
}

function textBlock(
	html: string,
	style: TextStyle,
	context: TransformContext,
): PortableTextTextBlock | undefined {
	const { children, markDefs } = context.parseInlineContent(html);
	if (!children.some((child) => child.text.trim())) {
		return undefined;
	}
	const block: PortableTextTextBlock = {
		_type: "block",
		_key: context.generateKey(),
		style,
		children,
	};
	if (markDefs.length > 0) {
		block.markDefs = markDefs;
	}
	return block;
}

/** Link every span that is not already inside a link */
function addLink(
	block: PortableTextTextBlock,
	rawHref: string | undefined,
	blank: boolean,
	context: TransformContext,
): void {
	const href = sanitizeHref(decodeUrlEntities(rawHref ?? ""));
	if (!href) return;
	const linkKeys = new Set(
		(block.markDefs ?? []).filter((def) => def._type === "link").map((def) => def._key),
	);
	const key = context.generateKey();
	let linked = false;
	for (const child of block.children) {
		if (child.marks?.some((mark) => linkKeys.has(mark))) continue;
		child.marks = [...(child.marks ?? []), key];
		linked = true;
	}
	if (linked) {
		block.markDefs = [
			...(block.markDefs ?? []),
			{ _type: "link", _key: key, href, ...(blank ? { blank: true } : {}) },
		];
	}
}

function plainText(value: unknown): string {
	return typeof value === "string" ? extractText(value).trim() : "";
}

function imageBlock(
	src: string | undefined,
	wpId: number | undefined,
	options: ConvertOptions,
	context: TransformContext,
): PortableTextImageBlock | undefined {
	if (!src && !wpId) return undefined;
	const ref = wpId && options.mediaMap?.get(wpId);
	return {
		_type: "image",
		_key: context.generateKey(),
		asset: { _type: "reference", _ref: ref || String(wpId || src || ""), url: src },
	};
}

/**
 * kadence/rowlayout → columns block
 *
 * A single-column row is only a styled wrapper, so its content stays inline.
 */
export const rowLayout: BlockTransformer = (block, _options, context) => {
	const columns = block.innerBlocks.filter((inner) => inner.blockName === "kadence/column");
	if (columns.length < 2) {
		return context.transformBlocks(
			block.innerBlocks.flatMap((inner) =>
				inner.blockName === "kadence/column" ? inner.innerBlocks : [inner],
			),
		);
	}
	return [
		{
			_type: "columns",
			_key: context.generateKey(),
			columns: columns.map((column) => ({
				_type: "column" as const,
				_key: context.generateKey(),
				content: context.transformBlocks(column.innerBlocks),
			})),
		},
	];
};

/**
 * kadence/column outside a row → its content
 */
export const column: BlockTransformer = (block, _options, context) =>
	context.transformBlocks(block.innerBlocks);

/**
 * kadence/advancedheading → heading block, or a paragraph when set to a non-heading tag
 */
export const advancedHeading: BlockTransformer = (block, _options, context) => {
	const fragment = parseFragment(block.innerHTML);
	const element = findByClass(fragment.childNodes, "wp-block-kadence-advancedheading");
	const html = element ? serialize(element) : block.innerHTML;
	const htmlTag = attrString(block.attrs, "htmlTag") ?? "heading";
	const style = htmlTag === "heading" ? headingStyle(attrNumber(block.attrs, "level")) : "normal";

	const result = textBlock(html, style, context);
	if (!result) return [];
	addLink(
		result,
		attrString(block.attrs, "link"),
		attrBoolean(block.attrs, "linkTarget") === true,
		context,
	);
	return [result];
};

function toButton(
	text: unknown,
	link: unknown,
	inheritStyles: unknown,
	context: TransformContext,
): PortableTextButtonBlock | undefined {
	const label = plainText(text);
	if (!label) return undefined;
	return {
		_type: "button",
		_key: context.generateKey(),
		text: label,
		url: sanitizeHref(typeof link === "string" ? decodeUrlEntities(link) : ""),
		style: inheritStyles === "outline" ? "outline" : "default",
	};
}

function singleButtonBlock(
	block: GutenbergBlock,
	context: TransformContext,
): PortableTextButtonBlock | undefined {
	return toButton(block.attrs["text"], block.attrs["link"], block.attrs["inheritStyles"], context);
}

/**
 * kadence/advancedbtn → buttons block
 *
 * Buttons are kadence/singlebtn inner blocks, which save no markup, or a
 * `btns` attribute array before Kadence 3.
 */
export const advancedButtons: BlockTransformer = (block, _options, context) => {
	const singleButtons = block.innerBlocks.filter(
		(inner) => inner.blockName === "kadence/singlebtn",
	);
	const buttons = (
		singleButtons.length > 0
			? singleButtons.map((inner) => singleButtonBlock(inner, context))
			: attrArray(block.attrs, "btns")
					.filter(isRecord)
					.map((btn) => toButton(btn["text"], btn["link"], btn["inheritStyles"], context))
	).filter((button) => button !== undefined);

	if (buttons.length === 0) return [];
	return [{ _type: "buttons", _key: context.generateKey(), buttons, layout: "horizontal" }];
};

/**
 * kadence/singlebtn outside a button group → button block
 */
export const singleButton: BlockTransformer = (block, _options, context) => {
	const button = singleButtonBlock(block, context);
	return button ? [button] : [];
};

/**
 * kadence/image → image block
 */
export const image: BlockTransformer = (block, options, context) => {
	const result = imageBlock(
		extractSrc(block.innerHTML) ?? attrString(block.attrs, "url"),
		attrNumber(block.attrs, "id"),
		options,
		context,
	);
	if (!result) return [];

	result.alt = extractAlt(block.innerHTML) ?? attrString(block.attrs, "alt");
	result.caption = extractCaption(block.innerHTML);
	const align = attrString(block.attrs, "align");
	if (
		align === "left" ||
		align === "center" ||
		align === "right" ||
		align === "wide" ||
		align === "full"
	) {
		result.alignment = align;
	}
	const link = sanitizeHref(decodeUrlEntities(attrString(block.attrs, "link") ?? ""));
	if (link) {
		result.link = attrBoolean(block.attrs, "linkTarget") ? { href: link, blank: true } : link;
	}
	return [result];
};

/**
 * kadence/infobox → optional image, title, text, and a "learn more" button
 *
 * Without a learn-more label, the box link goes on the title instead.
 */
export const infoBox: BlockTransformer = (block, options, context) => {
	const nodes = parseFragment(block.innerHTML).childNodes;
	const result: PortableTextBlock[] = [];

	const media = findByClass(nodes, "kt-blocks-info-box-media");
	const mediaImg = media ? findByTag(media.childNodes, "img") : undefined;
	if (mediaImg) {
		const src = getAttribute(mediaImg, "src");
		const mediaImage = attrArray(block.attrs, "mediaImage").find(isRecord);
		const wpId = typeof mediaImage?.["id"] === "number" ? mediaImage["id"] : undefined;
		const mediaBlock = imageBlock(src ? decodeUrlEntities(src) : undefined, wpId, options, context);
		if (mediaBlock) {
			mediaBlock.alt = getAttribute(mediaImg, "alt");
			result.push(mediaBlock);
		}
	}

	const anchor = findByTag(nodes, "a");
	const href = anchor ? getAttribute(anchor, "href") : undefined;
	const blank = anchor ? getAttribute(anchor, "target") === "_blank" : false;

	const titleElement = findByClass(nodes, "kt-blocks-info-box-title");
	const title = titleElement
		? textBlock(serialize(titleElement), tagStyle(titleElement.tagName, "normal"), context)
		: undefined;
	const textElement = findByClass(nodes, "kt-blocks-info-box-text");
	const text = textElement ? textBlock(serialize(textElement), "normal", context) : undefined;
	const learnMoreElement = findByClass(nodes, "kt-blocks-info-box-learnmore");
	const learnMore = learnMoreElement ? extractText(serialize(learnMoreElement)).trim() : "";

	const button = learnMore && href ? toButton(learnMore, href, undefined, context) : undefined;
	if (title) {
		if (!button) addLink(title, href, blank, context);
		result.push(title);
	}
	if (text) result.push(text);
	if (button) {
		result.push({
			_type: "buttons",
			_key: context.generateKey(),
			buttons: [button],
			layout: "horizontal",
		});
	}
	return result;
};

function listItemBlock(
	html: string,
	level: number | undefined,
	href: string | undefined,
	blank: boolean,
	context: TransformContext,
): PortableTextTextBlock | undefined {
	const nodes = parseFragment(html).childNodes;
	const textElement = findByClass(nodes, "kt-svg-icon-list-text");
	const result = textBlock(textElement ? serialize(textElement) : html, "normal", context);
	if (!result) return undefined;
	result.listItem = "bullet";
	result.level = (level ?? 0) + 1;
	addLink(result, href, blank, context);
	return result;
}

/**
 * kadence/listitem → bullet list item
 */
export const listItem: BlockTransformer = (block, _options, context) => {
	const result = listItemBlock(
		block.innerHTML,
		attrNumber(block.attrs, "level"),
		attrString(block.attrs, "link"),
		attrString(block.attrs, "target") === "_blank",
		context,
	);
	return result ? [result] : [];
};

/**
 * kadence/iconlist → bullet list
 *
 * Before Kadence 3 the items were saved as `<li>` markup on the list itself,
 * with their level in the `items` attribute array.
 */
export const iconList: BlockTransformer = (block, options, context) => {
	const items = block.innerBlocks.filter((inner) => inner.blockName === "kadence/listitem");
	if (items.length > 0) {
		return items.flatMap((item) => listItem(item, options, context));
	}

	const legacyItems = attrArray(block.attrs, "items");
	return findElements(
		parseFragment(block.innerHTML).childNodes,
		(element) => element.tagName === "li",
	)
		.map((li, index) => {
			const item = legacyItems[index];
			const level = isRecord(item) && typeof item["level"] === "number" ? item["level"] : undefined;
			const anchor = findByTag(li.childNodes, "a");
			return listItemBlock(
				serialize(li),
				level,
				anchor ? getAttribute(anchor, "href") : undefined,
				anchor ? getAttribute(anchor, "target") === "_blank" : false,
				context,
			);
		})
		.filter((item) => item !== undefined);
};

/**
 * kadence/tabs → a section title per tab followed by its content
 *
 * Tab titles live in the `titles` attribute; the saved tab list is the fallback.
 */
export const tabs: BlockTransformer = (block, _options, context) => {
	const titles = attrArray(block.attrs, "titles");
	const savedTitles = findElements(parseFragment(block.innerHTML).childNodes, (element) =>
		hasClass(element, "kt-title-text"),
	);

	return block.innerBlocks
		.filter((inner) => inner.blockName === "kadence/tab")
		.flatMap((tab, position) => {
			const index = (attrNumber(tab.attrs, "id") ?? position + 1) - 1;
			const entry = titles[index];
			const titleHtml =
				isRecord(entry) && typeof entry["text"] === "string"
					? entry["text"]
					: savedTitles[index]
						? serialize(savedTitles[index])
						: "";
			const title = textBlock(titleHtml, SECTION_TITLE_STYLE, context);
			const content = context.transformBlocks(tab.innerBlocks);
			return title ? [title, ...content] : content;
		});
};

/**
 * kadence/pane → its title as a section title, followed by its content
 */
export const pane: BlockTransformer = (block, _options, context) => {
	const titleElement = findByClass(
		parseFragment(block.innerHTML).childNodes,
		"kt-blocks-accordion-title",
	);
	const style = tagStyle(attrString(block.attrs, "titleTag"), SECTION_TITLE_STYLE);
	const title = titleElement ? textBlock(serialize(titleElement), style, context) : undefined;
	const content = context.transformBlocks(block.innerBlocks);
	return title ? [title, ...content] : content;
};

/**
 * kadence/accordion → each pane in order
 */
export const accordion: BlockTransformer = (block, _options, context) =>
	context.transformBlocks(block.innerBlocks.filter((inner) => inner.blockName === "kadence/pane"));

interface TestimonialDisplay {
	title: boolean;
	content: boolean;
	name: boolean;
	occupation: boolean;
}

const SHOW_ALL: TestimonialDisplay = { title: true, content: true, name: true, occupation: true };

function testimonialBlocks(
	attrs: Record<string, unknown>,
	display: TestimonialDisplay,
	context: TransformContext,
): PortableTextBlock[] {
	const title = display.title ? plainText(attrs["title"]) : "";
	const content = display.content ? plainText(attrs["content"]) : "";
	const citation = [
		display.name ? plainText(attrs["name"]) : "",
		display.occupation ? plainText(attrs["occupation"]) : "",
	]
		.filter(Boolean)
		.join(", ");

	const result: PortableTextBlock[] = [];
	if (title) {
		result.push({
			_type: "block",
			_key: context.generateKey(),
			style: "normal",
			children: [{ _type: "span", _key: context.generateKey(), text: title, marks: ["strong"] }],
		});
	}
	if (content) {
		result.push({
			_type: "pullquote",
			_key: context.generateKey(),
			text: content,
			citation: citation || undefined,
		});
	} else if (citation) {
		result.push({
			_type: "block",
			_key: context.generateKey(),
			style: "normal",
			children: [{ _type: "span", _key: context.generateKey(), text: citation }],
		});
	}
	return result;
}

/**
 * kadence/testimonials → title and pullquote per testimonial
 *
 * Testimonials save no markup: their text is in kadence/testimonial
 * attributes, or a `testimonials` attribute array before Kadence 3.
 */
export const testimonials: BlockTransformer = (block, _options, context) => {
	const display: TestimonialDisplay = {
		title: attrBoolean(block.attrs, "displayTitle") ?? true,
		content: attrBoolean(block.attrs, "displayContent") ?? true,
		name: attrBoolean(block.attrs, "displayName") ?? true,
		occupation: attrBoolean(block.attrs, "displayOccupation") ?? true,
	};
	const items = block.innerBlocks.filter((inner) => inner.blockName === "kadence/testimonial");
	const entries =
		items.length > 0
			? items.map((item) => item.attrs)
			: attrArray(block.attrs, "testimonials").filter(isRecord);
	return entries.flatMap((attrs) => testimonialBlocks(attrs, display, context));
};

/**
 * kadence/testimonial outside a testimonials block → title and pullquote
 */
export const testimonial: BlockTransformer = (block, _options, context) =>
	testimonialBlocks(block.attrs, SHOW_ALL, context);

/**
 * kadence/countup → paragraph with the final number in bold, then its title
 */
export const countUp: BlockTransformer = (block, _options, context) => {
	const end = attrNumber(block.attrs, "end") ?? 100;
	const separator = attrString(block.attrs, "separator") ?? "";
	const [whole = "", fraction] = String(end).split(".");
	const decimal = attrString(block.attrs, "decimal") || ".";
	const number =
		(attrString(block.attrs, "prefix") ?? "") +
		whole.replace(THOUSANDS_PATTERN, separator) +
		(fraction ? decimal + fraction : "") +
		(attrString(block.attrs, "suffix") ?? "");

	const children: PortableTextTextBlock["children"] = [
		{ _type: "span", _key: context.generateKey(), text: number, marks: ["strong"] },
	];
	const title =
		attrBoolean(block.attrs, "displayTitle") === false ? "" : plainText(block.attrs["title"]);
	if (title) {
		children.push({ _type: "span", _key: context.generateKey(), text: ` ${title}` });
	}
	return [{ _type: "block", _key: context.generateKey(), style: "normal", children }];
};

type TableCell = PortableTextTableBlock["rows"][number]["cells"][number];

/**
 * kadence/table → table block
 *
 * Cells hold blocks; a table whose cells contain anything other than text
 * keeps that content as ordinary blocks instead of losing it.
 */
export const table: BlockTransformer = (block, _options, context) => {
	const rows = block.innerBlocks.filter((inner) => inner.blockName === "kadence/table-row");
	const firstRowHeader = attrBoolean(block.attrs, "isFirstRowHeader") === true;
	const firstColumnHeader = attrBoolean(block.attrs, "isFirstColumnHeader") === true;

	const converted = rows.map((row) =>
		row.innerBlocks
			.filter((inner) => inner.blockName === "kadence/table-data")
			.map((cell) => context.transformBlocks(cell.innerBlocks)),
	);
	const textOnly = converted.every((cells) =>
		cells.every((content) => content.every((inner) => inner._type === "block")),
	);
	if (!textOnly) {
		return converted.flat(2);
	}
	if (rows.length === 0) return [];

	return [
		{
			_type: "table",
			_key: context.generateKey(),
			rows: converted.map((cells, rowIndex) => ({
				_type: "tableRow" as const,
				_key: context.generateKey(),
				cells: cells.map((content, columnIndex): TableCell => {
					const cell: TableCell = {
						_type: "tableCell",
						_key: context.generateKey(),
						content: [],
					};
					const markDefs: NonNullable<TableCell["markDefs"]> = [];
					for (const inner of content) {
						if (inner._type !== "block") continue;
						if (cell.content.length > 0) {
							cell.content.push({ _type: "span", _key: context.generateKey(), text: "\n" });
						}
						cell.content.push(...inner.children);
						markDefs.push(...(inner.markDefs ?? []));
					}
					if (markDefs.length > 0) cell.markDefs = markDefs;
					if ((firstRowHeader && rowIndex === 0) || (firstColumnHeader && columnIndex === 0)) {
						cell.isHeader = true;
					}
					return cell;
				}),
			})),
			hasHeaderRow: firstRowHeader,
		},
	];
};

/**
 * kadence/spacer → break block
 */
export const spacer: BlockTransformer = (_block, _options, context) => [
	{ _type: "break", _key: context.generateKey(), style: "lineBreak" },
];

interface GalleryImage {
	src: string | undefined;
	wpId: number | undefined;
	alt: string;
	caption: string;
}

function galleryImagesFromMarkup(html: string): GalleryImage[] {
	const items = findElements(parseFragment(html).childNodes, (element) =>
		hasClass(element, "kadence-blocks-gallery-item"),
	);
	return items.flatMap((item) => {
		const img = findByTag(item.childNodes, "img");
		if (!img) return [];
		const src = getAttribute(img, "data-full-image") || getAttribute(img, "src");
		const dataId = Number(getAttribute(img, "data-id"));
		const captionElement = findByClass(item.childNodes, "kadence-blocks-gallery-item__caption");
		return [
			{
				src: src ? decodeUrlEntities(src) : undefined,
				wpId: Number.isInteger(dataId) && dataId > 0 ? dataId : undefined,
				alt: getAttribute(img, "alt") ?? "",
				caption: captionElement ? extractText(serialize(captionElement)).trim() : "",
			},
		];
	});
}

/**
 * kadence/advancedgallery → gallery block
 *
 * Kadence 3 renders galleries in PHP from the `imagesDynamic` attribute;
 * older galleries saved their images as markup.
 */
export const advancedGallery: BlockTransformer = (block, options, context) => {
	const dynamicImages = attrArray(block.attrs, "imagesDynamic")
		.filter(isRecord)
		.map(
			(entry): GalleryImage => ({
				src: typeof entry["url"] === "string" && entry["url"] ? entry["url"] : undefined,
				wpId: typeof entry["id"] === "number" ? entry["id"] : undefined,
				alt: plainText(entry["alt"]),
				caption: plainText(entry["caption"]),
			}),
		);
	const source =
		dynamicImages.length > 0 ? dynamicImages : galleryImagesFromMarkup(block.innerHTML);
	const showCaption = attrBoolean(block.attrs, "showCaption") === true;

	const images: PortableTextGalleryBlock["images"] = [];
	for (const { src, wpId, alt, caption } of source) {
		const asset = imageBlock(src, wpId, options, context);
		if (!asset) continue;
		images.push({
			_type: "image",
			_key: asset._key,
			asset: asset.asset,
			alt: alt || undefined,
			caption: showCaption && caption ? caption : undefined,
		});
	}
	if (images.length === 0) return [];

	const columns = attrArray(block.attrs, "columns")[0];
	return [
		{
			_type: "gallery",
			_key: context.generateKey(),
			images,
			columns: typeof columns === "number" ? columns : 3,
		},
	];
};
