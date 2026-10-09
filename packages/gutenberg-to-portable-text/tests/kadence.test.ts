/**
 * Tests for Kadence Blocks conversion
 *
 * The fixtures are post content saved by Kadence Blocks 3.7 in the block editor.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type {
	PortableTextBlock,
	PortableTextButtonsBlock,
	PortableTextColumnsBlock,
	PortableTextGalleryBlock,
	PortableTextImageBlock,
	PortableTextPullquoteBlock,
	PortableTextTableBlock,
	PortableTextTextBlock,
} from "../src/types.js";

const showcase = readFileSync(new URL("./fixtures/kadence-showcase.txt", import.meta.url), "utf8");
const edgeCases = readFileSync(
	new URL("./fixtures/kadence-edge-cases.txt", import.meta.url),
	"utf8",
);

function textOf(block: PortableTextBlock | undefined): string {
	return block?._type === "block" ? block.children.map((child) => child.text).join("") : "";
}

function linkHrefs(block: PortableTextTextBlock): string[] {
	return (block.markDefs ?? [])
		.filter((def) => def._type === "link")
		.map((def) => String(def["href"]));
}

function ofType<T extends PortableTextBlock["_type"]>(
	blocks: PortableTextBlock[],
	type: T,
): Array<Extract<PortableTextBlock, { _type: T }>> {
	return blocks.filter(
		(block): block is Extract<PortableTextBlock, { _type: T }> => block._type === type,
	);
}

describe("Kadence Blocks", () => {
	describe("saved page", () => {
		const result = gutenbergToPortableText(showcase);

		it("converts every Kadence block instead of keeping raw HTML", () => {
			expect(ofType(result, "htmlBlock")).toEqual([]);
		});

		it("keeps the two-column row as columns", () => {
			const [columns] = ofType(result, "columns") as PortableTextColumnsBlock[];
			expect(columns?.columns).toHaveLength(2);
			const [first, second] = columns!.columns;
			expect(first!.content.map((block) => block._type)).toEqual(["block", "block", "buttons"]);
			expect(first!.content[0]).toMatchObject({ _type: "block", style: "h2" });
			expect(textOf(first!.content[0])).toBe("Our Services");
			expect(second!.content[0]).toMatchObject({
				_type: "image",
				asset: { _ref: "6", url: "https://example.org/wp-content/uploads/2026/10/team-photo.jpg" },
				alt: "Our team",
				caption: "The team at work",
			});
		});

		it("keeps button text and links, which Kadence saves only in attributes", () => {
			const columns = ofType(result, "columns")[0]!;
			const buttons = columns.columns[0]!.content[2] as PortableTextButtonsBlock;
			expect(buttons.buttons.map(({ text, url }) => ({ text, url }))).toEqual([
				{ text: "Contact Us", url: "/contact" },
				{ text: "See Our Work", url: "https://example.org/work" },
			]);
		});

		it("puts each tab and accordion title before its content", () => {
			const texts = result.map((block) => [
				block._type === "block" ? block.style : block._type,
				textOf(block),
			]);
			const start = texts.findIndex(([, value]) => value === "Overview");
			expect(texts.slice(start, start + 8)).toEqual([
				["h3", "Overview"],
				["normal", "Overview: everything you need to launch."],
				["h3", "Pricing"],
				["normal", "Pricing: flat monthly fee, no surprises."],
				["h3", "Do you work with churches?"],
				["normal", "Yes, many of our clients are churches."],
				["h3", "How long does a site take?"],
				["normal", "Usually four to six weeks."],
			]);
		});

		it("keeps testimonials, which save no markup", () => {
			const quotes = ofType(result, "pullquote") as PortableTextPullquoteBlock[];
			expect(quotes.map(({ text, citation }) => ({ text, citation }))).toEqual([
				{ text: "They rebuilt our site in a week.", citation: "Jane Doe, Director" },
				{ text: "Always quick to respond.", citation: "John Smith, Pastor" },
			]);
			const titles = quotes.map((quote) => textOf(result[result.indexOf(quote) - 1]));
			expect(titles).toEqual(["Fantastic", "Reliable"]);
		});

		it("turns the icon list into a bullet list with its links", () => {
			const items = result.filter(
				(block): block is PortableTextTextBlock => block._type === "block" && !!block.listItem,
			);
			expect(items.map(textOf)).toEqual(["Fast delivery", "Fair pricing", "Local support"]);
			expect(items.every((item) => item.listItem === "bullet" && item.level === 1)).toBe(true);
			expect(linkHrefs(items[1]!)).toEqual(["/pricing"]);
		});

		it("turns the info box into a title, text, and learn-more button", () => {
			const start = result.findIndex((block) => textOf(block) === "Strategy");
			expect(result[start]).toMatchObject({ _type: "block", style: "h2" });
			expect(textOf(result[start + 1])).toBe("We plan your launch from day one.");
			expect(result[start + 2]).toMatchObject({
				_type: "buttons",
				buttons: [{ text: "Learn More", url: "/services" }],
			});
		});

		it("converts the Kadence table into table rows", () => {
			const [table] = ofType(result, "table") as PortableTextTableBlock[];
			expect(
				table!.rows.map((row) =>
					row.cells.map((cell) => cell.content.map((span) => span.text).join("")),
				),
			).toEqual([
				["Plan", "Price"],
				["Basic", "$99/mo"],
			]);
			expect(table!.hasHeaderRow).toBe(false);
		});

		it("converts the count-up to its final number and title", () => {
			expect(result.map(textOf)).toContain("250 Sites launched");
		});
	});

	describe("advanced heading", () => {
		const result = gutenbergToPortableText(edgeCases);

		it("links the heading when Kadence wraps it in a link", () => {
			const heading = result[0] as PortableTextTextBlock;
			expect(heading.style).toBe("h4");
			expect(textOf(heading)).toBe("Linked heading");
			expect(heading.markDefs).toEqual([
				expect.objectContaining({ _type: "link", href: "/about", blank: true }),
			]);
			expect(
				heading.children.every((child) => child.marks?.includes(heading.markDefs![0]!._key)),
			).toBe(true);
		});

		it("keeps a heading set to a paragraph tag as a paragraph", () => {
			expect(result[1]).toMatchObject({ _type: "block", style: "normal" });
			expect(textOf(result[1])).toBe("Paragraph-styled heading");
		});

		it("keeps inline formatting", () => {
			const columns = ofType(gutenbergToPortableText(showcase), "columns")[0]!;
			const heading = columns.columns[0]!.content[0] as PortableTextTextBlock;
			expect(heading.children.find((child) => child.text === "Services")?.marks).toEqual([
				"strong",
			]);
		});
	});

	describe("gallery", () => {
		it("reads Kadence 3 gallery images from attributes and resolves media IDs", () => {
			const mediaMap = new Map([
				[7, "media-office"],
				[6, "media-team"],
			]);
			const [gallery] = ofType(
				gutenbergToPortableText(edgeCases, { mediaMap }),
				"gallery",
			) as PortableTextGalleryBlock[];
			expect(gallery!.columns).toBe(2);
			expect(
				gallery!.images.map(({ asset, alt, caption }) => ({ ref: asset._ref, alt, caption })),
			).toEqual([
				{ ref: "media-office", alt: "Our Office", caption: "Our Office caption" },
				{ ref: "media-team", alt: "Our Team", caption: "Our Team caption" },
			]);
		});

		it("drops captions when the gallery hides them", () => {
			const content = edgeCases.replace('"showCaption":true,', "");
			const [gallery] = ofType(gutenbergToPortableText(content), "gallery");
			expect(gallery!.images.map((image) => image.caption)).toEqual([undefined, undefined]);
		});

		it("reads images from markup in galleries saved before Kadence 3", () => {
			const content = `<!-- wp:kadence/advancedgallery {"uniqueID":"_a1","ids":[11],"showCaption":true} -->
<div class="wp-block-kadence-advancedgallery"><ul class="kb-gallery-ul"><li class="kadence-blocks-gallery-item"><div class="kadence-blocks-gallery-item-inner"><figure class="kb-gallery-figure"><img src="https://example.org/a-300x200.jpg" data-full-image="https://example.org/a.jpg" alt="First" data-id="11" class="wp-image-11"/><figcaption class="kadence-blocks-gallery-item__caption">First caption</figcaption></figure></div></li></ul></div>
<!-- /wp:kadence/advancedgallery -->`;
			const [gallery] = ofType(gutenbergToPortableText(content), "gallery");
			expect(gallery!.images).toMatchObject([
				{
					asset: { _ref: "11", url: "https://example.org/a.jpg" },
					alt: "First",
					caption: "First caption",
				},
			]);
		});
	});

	describe("info box", () => {
		it("keeps the box image and links the title when there is no learn-more label", () => {
			const result = gutenbergToPortableText(edgeCases);
			const start = result.findIndex((block) => textOf(block) === "Photo box");
			const image = result[start - 1] as PortableTextImageBlock;
			expect(image).toMatchObject({
				_type: "image",
				asset: { _ref: "7", url: "https://example.org/wp-content/uploads/2026/10/office.jpg" },
				alt: "Our Office",
			});
			expect(linkHrefs(result[start] as PortableTextTextBlock)).toEqual(["/photo"]);
			expect(textOf(result[start + 1])).toBe("Box text.");
		});
	});

	describe("icon list", () => {
		it("keeps nested levels and item links", () => {
			const items = gutenbergToPortableText(edgeCases).filter(
				(block): block is PortableTextTextBlock => block._type === "block" && !!block.listItem,
			);
			expect(items.map((item) => [textOf(item), item.level, linkHrefs(item)])).toEqual([
				["Parent item", 1, []],
				["Child item", 2, ["https://example.org/child"]],
			]);
		});

		it("reads items from markup in lists saved before Kadence 3", () => {
			const content = `<!-- wp:kadence/iconlist {"uniqueID":"_b1","listCount":2,"items":[{"icon":"fe_check","link":"","target":"_self","text":"One","level":0},{"icon":"fe_check","link":"/two","target":"_blank","text":"Two","level":1}]} -->
<div class="wp-block-kadence-iconlist kt-svg-icon-list-items"><ul class="kt-svg-icon-list"><li class="kt-svg-icon-list-style-default kt-svg-icon-list-item-wrap kt-svg-icon-list-item-0 kt-svg-icon-list-level-0"><span class="kb-svg-icon-wrap"></span><span class="kt-svg-icon-list-text">One</span></li><li class="kt-svg-icon-list-style-default kt-svg-icon-list-item-wrap kt-svg-icon-list-item-1 kt-svg-icon-list-level-1"><a href="/two" class="kt-svg-icon-link" target="_blank" rel="noopener noreferrer"><span class="kb-svg-icon-wrap"></span><span class="kt-svg-icon-list-text">Two</span></a></li></ul></div>
<!-- /wp:kadence/iconlist -->`;
			const items = gutenbergToPortableText(content) as PortableTextTextBlock[];
			expect(
				items.map((item) => [item.listItem, item.level, textOf(item), linkHrefs(item)]),
			).toEqual([
				["bullet", 1, "One", []],
				["bullet", 2, "Two", ["/two"]],
			]);
		});
	});

	describe("buttons", () => {
		it("reads buttons saved before Kadence 3 from the btns attribute", () => {
			const content = `<!-- wp:kadence/advancedbtn {"uniqueID":"_c1","btnCount":2,"btns":[{"text":"Donate","link":"/donate","target":"_self","inheritStyles":"fill"},{"text":"Volunteer","link":"https://example.org/volunteer","target":"_blank","inheritStyles":"outline"}]} -->
<div class="wp-block-kadence-advancedbtn kt-btn-align-center"><div class="kt-btn-wrap kt-btn-wrap-0"><a class="kt-button button kt-btn-0-action" href="/donate"><span class="kt-btn-inner-text">Donate</span></a></div><div class="kt-btn-wrap kt-btn-wrap-1"><a class="kt-button button kt-btn-1-action" href="https://example.org/volunteer" target="_blank"><span class="kt-btn-inner-text">Volunteer</span></a></div></div>
<!-- /wp:kadence/advancedbtn -->`;
			const [buttons] = gutenbergToPortableText(content) as PortableTextButtonsBlock[];
			expect(buttons!.buttons.map(({ text, url, style }) => ({ text, url, style }))).toEqual([
				{ text: "Donate", url: "/donate", style: "default" },
				{ text: "Volunteer", url: "https://example.org/volunteer", style: "outline" },
			]);
		});

		it("drops unsafe button links", () => {
			const content = `<!-- wp:kadence/advancedbtn {"uniqueID":"_d1"} -->
<div class="wp-block-kadence-advancedbtn kb-buttons-wrap kb-btns_d1"><!-- wp:kadence/singlebtn {"uniqueID":"_d2","text":"Click","link":"javascript:alert(1)"} /--></div>
<!-- /wp:kadence/advancedbtn -->`;
			const [buttons] = gutenbergToPortableText(content) as PortableTextButtonsBlock[];
			expect(buttons!.buttons[0]).toMatchObject({ text: "Click", url: "" });
		});

		it("skips buttons without text", () => {
			const content = `<!-- wp:kadence/advancedbtn {"uniqueID":"_e1"} -->
<div class="wp-block-kadence-advancedbtn kb-buttons-wrap"><!-- wp:kadence/singlebtn {"uniqueID":"_e2","link":"/icon-only"} /--></div>
<!-- /wp:kadence/advancedbtn -->`;
			expect(gutenbergToPortableText(content)).toEqual([]);
		});
	});

	describe("testimonials", () => {
		it("reads testimonials saved before Kadence 3 from the testimonials attribute", () => {
			const content = `<!-- wp:kadence/testimonials {"uniqueID":"_f1","testimonials":[{"url":"","id":"","media":"icon","title":"Great","content":"Loved working with them.","name":"Ann","occupation":"CEO","rating":5}]} -->
<div class="wp-block-kadence-testimonials kt-testimonial-halign-center"></div>
<!-- /wp:kadence/testimonials -->`;
			const result = gutenbergToPortableText(content);
			expect(textOf(result[0])).toBe("Great");
			expect(result[1]).toMatchObject({
				_type: "pullquote",
				text: "Loved working with them.",
				citation: "Ann, CEO",
			});
		});

		it("leaves out the parts the testimonials block hides", () => {
			const content = `<!-- wp:kadence/testimonials {"uniqueID":"_g1","displayTitle":false,"displayOccupation":false} -->
<!-- wp:kadence/testimonial {"uniqueID":"_g2","title":"Hidden","content":"Shown.","name":"Ann","occupation":"CEO"} /-->
<!-- /wp:kadence/testimonials -->`;
			expect(gutenbergToPortableText(content)).toEqual([
				expect.objectContaining({ _type: "pullquote", text: "Shown.", citation: "Ann" }),
			]);
		});
	});

	describe("table", () => {
		it("marks the header row and joins multi-paragraph cells", () => {
			const [table] = ofType(
				gutenbergToPortableText(edgeCases),
				"table",
			) as PortableTextTableBlock[];
			expect(table!.hasHeaderRow).toBe(true);
			expect(table!.rows[0]!.cells.map((cell) => cell.isHeader)).toEqual([true, true]);
			const [nameCell, roleCell] = table!.rows[1]!.cells;
			expect(nameCell!.content.map((span) => span.text)).toEqual(["Ann", "\n", "Second line"]);
			expect(nameCell!.content[0]!.marks).toEqual(["strong"]);
			expect(roleCell!.markDefs).toEqual([
				expect.objectContaining({ _type: "link", href: "/team" }),
			]);
		});

		it("keeps non-text cell content as blocks instead of dropping it", () => {
			const content = `<!-- wp:kadence/table {"uniqueID":"_h1","columns":1} -->
<!-- wp:kadence/table-row {"uniqueID":"_h2","row":0} -->
<!-- wp:kadence/table-data {"uniqueID":"_h3","column":0} -->
<!-- wp:paragraph --><p>Before</p><!-- /wp:paragraph -->
<!-- wp:image {"id":5} --><figure class="wp-block-image"><img src="https://example.org/cell.jpg" alt="Cell" class="wp-image-5"/></figure><!-- /wp:image -->
<!-- /wp:kadence/table-data -->
<!-- /wp:kadence/table-row -->
<!-- /wp:kadence/table -->`;
			const result = gutenbergToPortableText(content);
			expect(result.map((block) => block._type)).toEqual(["block", "image"]);
			expect(textOf(result[0])).toBe("Before");
		});
	});

	describe("count-up", () => {
		it("formats the final number with prefix, suffix, and separator", () => {
			expect(
				textOf(
					ofType(gutenbergToPortableText(edgeCases), "block").find((block) =>
						textOf(block).includes("Raised"),
					),
				),
			).toBe("$1,250,000+ Raised");
		});

		it("uses Kadence's default end value when none is saved", () => {
			const content = `<!-- wp:kadence/countup {"uniqueID":"_i1","title":"Projects"} -->
<div class="wp-block-kadence-countup kb-count-up" data-start="0" data-end="100"><div class="kb-count-up-process kb-count-up-number"></div><div class="kb-count-up-title">Projects</div></div>
<!-- /wp:kadence/countup -->`;
			expect(textOf(gutenbergToPortableText(content)[0])).toBe("100 Projects");
		});
	});

	describe("row layout", () => {
		it("keeps a single-column row's content inline", () => {
			const result = gutenbergToPortableText(edgeCases);
			expect(ofType(result, "columns")).toEqual([]);
			expect(textOf(result.at(-1))).toBe("Single column content.");
		});
	});
});
