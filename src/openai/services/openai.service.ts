// src/openai/openai.service.ts
import { Injectable, Logger } from "@nestjs/common";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources";
import { openaiConfig } from "src/config/openai.config";
import { RestService } from "src/rest/services/rest.service";
import { AssitantRun } from "../types/openai-type";
import { CursorPage } from "openai/pagination";

@Injectable()
export class OpenAIService {
  private openAi: OpenAI;
  private readonly logger = new Logger("Message");

  constructor(private readonly restService: RestService) {
    this.openAi = new OpenAI(openaiConfig());
  }

  async chatGPT(
    messages: ChatCompletionMessageParam[],
    userId?: string
  ): Promise<
    Record<string, string | number> | Record<string, string | number>[]
  > {
    try {
      const completion = await this.openAi.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: "Create answer in JSON format." },
          ...messages,
        ],
        user: userId || undefined,
        response_format: { type: "json_object" },
      });
      const response = completion.choices[0].message.content;
      return JSON.parse(response);
    } catch (err) {
      this.logger.error(err);
    }
  }

  async createThread(messages: any[]): Promise<string> {
    const thread = await this.openAi.beta.threads.create({ messages });
    return thread.id;
  }

  async addThreadMessage(threadId: string, message: any) {
    console.log("add message to thread");
    await this.openAi.beta.threads.messages.create(threadId, message);
  }

  async getThreadMessages(threadId: string) {
    console.log("get messages from thread");
    return await this.openAi.beta.threads.messages.list(threadId);
  }

  async runAssistant(threadId: string, assistantId: string) {
    console.log("run assistant");
    return await this.openAi.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      model: "gpt-4-turbo-preview",
      tools: [{ type: "file_search" }],
    });
  }

  async checkRun(threadId: string, runId: string): Promise<AssitantRun> {
    console.log("check run");
    return (await this.openAi.beta.threads.runs.retrieve(
      threadId,
      runId
    )) as AssitantRun;
  }

  async createImage(prompt: string): Promise<string> {
    const response = await this.restService.post(
      "https://api.openai.com/v1/images/generations",
      {
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1792x1024",
        response_format: "b64_json",
        quality: "standard",
        style: "natural",
      },
      {
        headers: {
          Authorization: `Bearer ${openaiConfig().apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    //@ts-ignore
    return response.data.data[0].b64_json;
  }
}
