import { AfterEffectsExpressionControl, AfterEffectsShapeCreate, AfterEffectsTextAnimate, z } from "@adobe-mcp/schemas";

export interface AfterEffectsPropertyCommand { readonly matchName: string; readonly propertyGroup: string; readonly properties: Record<string, unknown>; }

export function buildShapeCommands(input: z.input<typeof AfterEffectsShapeCreate>): readonly AfterEffectsPropertyCommand[] {
  const value = AfterEffectsShapeCreate.parse(input);
  const commands: AfterEffectsPropertyCommand[] = value.shapes.map((shape) => ({ matchName: shape.type === "rectangle" ? "ADBE Vector Shape - Rect" : shape.type === "ellipse" ? "ADBE Vector Shape - Ellipse" : shape.type === "polystar" ? "ADBE Vector Shape - Star" : "ADBE Vector Shape - Group", propertyGroup: value.groupName, properties: { ...(shape.vertices === undefined ? {} : { vertices: shape.vertices }), ...(shape.size === undefined ? {} : { size: shape.size }) } }));
  if (value.modifiers.trimPaths) commands.push({ matchName: "ADBE Vector Filter - Trim", propertyGroup: value.groupName, properties: value.modifiers.trimPaths });
  if (value.modifiers.repeater) commands.push({ matchName: "ADBE Vector Filter - Repeater", propertyGroup: value.groupName, properties: value.modifiers.repeater });
  if (value.modifiers.puckerAndBloat) commands.push({ matchName: "ADBE Vector Filter - PB", propertyGroup: value.groupName, properties: value.modifiers.puckerAndBloat });
  return commands;
}

export function buildTextAnimator(input: z.input<typeof AfterEffectsTextAnimate>): AfterEffectsPropertyCommand {
  const value = AfterEffectsTextAnimate.parse(input);
  return { matchName: "ADBE Text Animator", propertyGroup: value.layerId, properties: { text: value.text, properties: value.properties, rangeSelector: value.rangeSelector, ...(value.wiggle ? { wiggle: value.wiggle } : {}) } };
}

export function buildExpressionControl(input: z.input<typeof AfterEffectsExpressionControl>): AfterEffectsPropertyCommand {
  const value = AfterEffectsExpressionControl.parse(input);
  const matchName = { slider: "ADBE Slider Control", color: "ADBE Color Control", point: "ADBE Point Control", angle: "ADBE Angle Control" }[value.control];
  return { matchName, propertyGroup: value.layerId, properties: { name: value.name, value: value.value, ...(value.expression ? { expression: value.expression } : {}) } };
}
