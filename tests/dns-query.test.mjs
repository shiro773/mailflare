import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "mailflare-dns-query-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { queryDns } from "./src/lib/dns-query";
			export { fetchRemoteImage, RemoteImageError } from "./src/lib/remote-images/fetch";`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { queryDns, fetchRemoteImage, RemoteImageError } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const answer = (type, data, name = "images.example.") => ({ name, type, TTL: 60, data });
const aliases = [answer(5, "edge.example."), answer(5, "cdn.example.", "edge.example.")];
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

for (const [type, expected] of [
	["A", ["93.184.216.34"]],
	["AAAA", ["2606:4700:4700::1111"]],
	["CNAME", ["edge.example.", "cdn.example."]],
	["MX", ["10 mail.example."]],
	["TXT", ["first second"]],
]) {
	test(`${type} lookups return only the requested record type`, async (t) => {
		t.mock.method(globalThis, "fetch", async (url, init) => {
			assert.equal(new URL(url).searchParams.get("type"), type);
			assert.equal(init.headers.accept, "application/dns-json");
			return Response.json({ Status: 0, Answer: [
				...aliases, answer(1, "93.184.216.34"), answer(28, "2606:4700:4700::1111"),
				answer(15, "10 mail.example."), answer(16, '"first " "second"'), answer(0, "unrelated"),
			] });
		});
		assert.deepEqual(await queryDns("images.example", type), expected);
	});
}

test("a CNAME-only response does not masquerade as an address", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ Status: 0, Answer: aliases }));
	assert.deepEqual(await queryDns("images.example", "A"), []);
	assert.deepEqual(await queryDns("images.example", "AAAA"), []);
});

test("NXDOMAIN and empty answers remain empty, while DNS failures still throw", async (t) => {
	const responses = [
		Response.json({ Status: 3 }), Response.json({ Status: 0 }),
		Response.json({ Status: 2 }), new Response(null, { status: 503 }),
	];
	t.mock.method(globalThis, "fetch", async () => responses.shift());
	assert.deepEqual(await queryDns("images.example", "A"), []);
	assert.deepEqual(await queryDns("images.example", "AAAA"), []);
	await assert.rejects(queryDns("images.example", "A"), /returned status 2/);
	await assert.rejects(queryDns("images.example", "A"), /failed \(503\)/);
});

test("the image proxy accepts a public IPv4 address behind a CNAME chain with no IPv6 address", async (t) => {
	let imageRequests = 0;
	t.mock.method(globalThis, "fetch", async (url) => {
		const parsed = new URL(url);
		if (parsed.hostname === "cloudflare-dns.com") {
			return Response.json({ Status: 0, Answer: [
				...aliases, ...(parsed.searchParams.get("type") === "A" ? [answer(1, "93.184.216.34", "cdn.example.")] : []),
			] });
		}
		imageRequests += 1;
		return new Response(png, { headers: { "Content-Type": "image/png" } });
	});
	const result = await fetchRemoteImage("https://images.example/photo.png");
	assert.deepEqual(result.body, png);
	assert.equal(imageRequests, 1);
});

test("the image proxy still rejects private addresses behind a CNAME chain before fetching", async (t) => {
	let imageRequests = 0;
	t.mock.method(globalThis, "fetch", async (url) => {
		const parsed = new URL(url);
		if (parsed.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: [
			...aliases, ...(parsed.searchParams.get("type") === "A" ? [answer(1, "127.0.0.1")] : []),
		] });
		imageRequests += 1;
		return new Response(png, { headers: { "Content-Type": "image/png" } });
	});
	await assert.rejects(fetchRemoteImage("https://images.example/photo.png"),
		(error) => error instanceof RemoteImageError && error.code === "invalid_url");
	assert.equal(imageRequests, 0);
});

test("the image proxy rejects aliases without any terminal address", async (t) => {
	t.mock.method(globalThis, "fetch", async (url) => {
		assert.equal(new URL(url).hostname, "cloudflare-dns.com");
		return Response.json({ Status: 0, Answer: aliases });
	});
	await assert.rejects(fetchRemoteImage("https://images.example/photo.png"),
		(error) => error instanceof RemoteImageError && error.code === "invalid_url");
});
