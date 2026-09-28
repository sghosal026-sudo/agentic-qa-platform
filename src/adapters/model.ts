import OpenAI from "openai";
import { required } from "../core/runtime.js";

export class Model {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: required("OPENROUTER_API_KEY"), baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1" });
  }

  async json(prompt: string): Promise<unknown> {
    const response = await this.client.chat.completions.create({
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-oss-120b",
      messages: [{ role: "system", content: "You are a senior QA analyst. Return only JSON. Use exact source evidence; do not invent behavior, routes, fields, selectors, or outcomes." }, { role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("OpenRouter returned no JSON");
    return JSON.parse(content) as unknown;
  }
}
