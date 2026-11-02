import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webBrowserExtension from "../src/web-browser/index.ts";

type EnumJson = { type?: string; enum?: string[]; description?: string };

function registeredTool(factory: ExtensionFactory): ToolDefinition {
	let tool: ToolDefinition | undefined;
	const fakePi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (candidate: ToolDefinition) => {
			tool = candidate;
		},
	} as unknown as ExtensionAPI;
	factory(fakePi);
	if (!tool) throw new Error("tool was not registered");
	return tool;
}

test("web_browser parameter schema preserves string enums and optionality", () => {
	const tool = registeredTool(webBrowserExtension);
	const serialized = JSON.stringify(tool.parameters);
	const schema = JSON.parse(serialized) as {
		required?: string[];
		properties: Record<
			string,
			EnumJson & { items?: { properties: Record<string, EnumJson> } }
		>;
	};

	const actions = schema.properties.action.enum;
	assert.equal(schema.properties.action.type, "string");
	assert.equal(schema.properties.action.description, "Browser action to perform");
	assert.ok(actions);
	assert.equal(actions.length, 29);
	assert.equal(actions[0], "navigate");
	assert.equal(actions.at(-1), "close");
	assert.ok(actions.includes("set_dialog_behavior"));

	assert.deepEqual(schema.properties.dialogAction.enum, ["accept", "dismiss"]);
	assert.deepEqual(schema.properties.mode.enum, ["fill", "press"]);
	assert.deepEqual(schema.properties.state.enum, ["visible", "hidden", "attached", "detached"]);
	assert.deepEqual(schema.properties.cookies.items?.properties.sameSite.enum, ["Strict", "Lax", "None"]);
	assert.equal(serialized.includes("~unsafe"), false);

	const required = schema.required;
	assert.ok(required);
	assert.ok(required.includes("action"));
	assert.equal(required.includes("dialogAction"), false);
	assert.equal(required.includes("mode"), false);
	assert.equal(required.includes("state"), false);
});
