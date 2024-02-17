import { InjectBot } from "@grammyjs/nestjs";
import { Bot, Context } from "grammy";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, Interval } from "@nestjs/schedule";
import { UserService } from "src/user/services/user.service";
import { Between, In, IsNull, LessThanOrEqual, MoreThan, Not } from "typeorm";
import { SubscriptionService } from "src/subscription/services/subscription.service";
import { SubscriptionStatusEnum } from "src/subscription/enums/subscription-status.enum";
import { MealService } from "./meal.service";
import { MealEntity } from "../entities/meal.entity";
import { MealStatusEnum } from "../enums/meal-status.enum";
import { MealTypeEnum, getMealTypeLabels } from "../enums/meal-type.enum";
import { mealGenerationPrompt } from "src/openai/prompts/meal.prompt";
import { OpenAIService } from "src/openai/services/openai.service";

import {
  daysLeftInWeek,
  formatDateToShortDate,
  getDatesForTheRestOfWeek,
  getStartAndEndOfWeek,
} from "src/shared/utilities/date.utility";
import { MealGroupEntity } from "../entities/meal-group.entity";
import { MealGroupService } from "./meal-group.service";
import { MealGroupStatusEnum } from "../enums/meal-group-status.enum";
import { userPrompt } from "src/openai/prompts/user.prompt";
import { OpenAIAssistantEnum } from "src/openai/enums/assistant.enum";
import { markdownToNodes } from "src/telegram/utilities/telegraph.utility";
import { TelegraphService } from "src/telegram/services/telegraph.service";

@Injectable()
export class MealGenerateCron {
  public get bot(): Bot<Context> {
    return this._bot;
  }
  constructor(
    @InjectBot()
    private readonly _bot: Bot<Context>,
    private readonly userService: UserService,
    private readonly subscriptionService: SubscriptionService,
    private readonly mealService: MealService,
    private readonly openAiService: OpenAIService,
    private readonly mealGroupService: MealGroupService,
    private readonly telegraphService: TelegraphService
  ) {}
  private readonly logger = new Logger(MealGenerateCron.name);

  @Interval(10000)
  async mealGroupsQueue() {
    const subscription = await this.subscriptionService.findOne({
      where: { status: SubscriptionStatusEnum.PAID },
      relations: ["user", "user.profile"],
    });

    if (!subscription) return;
    await this.subscriptionService.update(subscription.id, {
      status: SubscriptionStatusEnum.IN_PROGRESS,
    });
    try {
      const mealGroups: Partial<MealGroupEntity>[] = [];

      for (let m = 0; m < Math.ceil(subscription.generations / 7); m++) {
        if (!subscription.user?.profile?.metabolism)
          throw new Error("Metabolism not set");

        const threadId = await this.openAiService.createThread(
          userPrompt(subscription.user.profile)
        );

        const start = new Date(new Date().setHours(0, 0, 0, 0));
        start.setDate(start.getDate() + m * 7);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        mealGroups.push({
          start,
          end,
          threadId,
          subscriptionId: subscription.id,
        });
      }

      await this.mealGroupService
        .createBulk(mealGroups)
        .then(async () => {
          await this.subscriptionService.update(subscription.id, {
            status: SubscriptionStatusEnum.PROCESSED,
          });
        })
        .catch(console.log);
    } catch (err) {
      this.logger.error(err);
      await this.subscriptionService.update(subscription.id, {
        status: SubscriptionStatusEnum.FAILED,
      });
    }
  }

  @Interval(10000)
  async mealQueue() {
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.CREATED },
      relations: [
        "subscription",
        "subscription.user",
        "subscription.user.profile",
      ],
    });

    if (!mealGroup) return;
    await this.mealGroupService.update(mealGroup.id, {
      status: MealGroupStatusEnum.MEALS_QUEUE,
    });

    try {
      const meals: Partial<MealEntity>[] = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date(mealGroup.start);
        date.setDate(date.getDate() + i);
        mealGroup.subscription.user.profile.mealTypes.forEach((type) => {
          meals.push({
            userId: mealGroup.subscription.user.id,
            status: MealStatusEnum.CREATED,
            type,
            date,
            mealGroupId: mealGroup.id,
          });
        });
      }
      await this.mealService.createBulk(meals);
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.MEALS_GENERATION,
      });
    } catch (err) {
      console.log(err);
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.FAILED,
        failMessage: String(err),
      });
    }
  }

  @Interval(10000)
  async generateMealWithAI() {
    this.logger.log("start generating meal with AI");
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.MEALS_GENERATION },
      relations: ["meals"],
    });
    if (!mealGroup?.id) {
      return;
    }

    try {
      const meal = await this.mealService.findOne({
        where: { mealGroupId: mealGroup.id, status: MealStatusEnum.CREATED },
      });
      if (!meal?.id) throw new Error("No meals found to generate");
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.MEAL_GENERATING,
      });
      await this.mealService.update(meal.id, {
        status: MealStatusEnum.IN_PROGRESS,
      });

      await this.openAiService.addThreadMessage(mealGroup.threadId, {
        role: "user",
        content: meal.type,
      });
      const run = await this.openAiService.runAssistant(
        mealGroup.threadId,
        OpenAIAssistantEnum.NUTRI
      );
      await this.mealService.update(meal.id, { runId: run.id });
    } catch (err) {
      console.log(err);
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.FAILED,
        failMessage: String(err),
      });
    }
  }

  @Interval(10000)
  async checkRuns() {
    console.log("Check run");
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.MEAL_GENERATING },
    });
    if (!mealGroup?.id) return;

    try {
      const meal = await this.mealService.findOne({
        where: {
          mealGroupId: mealGroup.id,
          status: MealStatusEnum.IN_PROGRESS,
        },
      });
      if (!meal?.id || !meal?.runId) {
        return;
      }
      const run = await this.openAiService.checkRun(
        mealGroup.threadId,
        meal.runId
      );

      if (run.status === "completed") {
        const messages = await this.openAiService.getThreadMessages(
          mealGroup.threadId
        );

        const message = messages.data[0];
        if (!message?.id) {
          throw new Error("Message from Assistant is not provided");
        }
        if (message.content[0].type !== "text") {
          throw new Error("Got not text response");
        }
        const response = message.content[0]?.text?.value;
        console.log("🚀 ~ MealGenerateCron ~ checkRuns ~ messages:", response);
        await this.mealService.update(meal.id, {
          response,
          messageId: message.id,
          status: MealStatusEnum.GENERATED,
        });
        await this.mealGroupService.update(mealGroup.id, {
          status: MealGroupStatusEnum.MEALS_GENERATION,
        });
      } else if (
        ["requires_action", "cancelled", "failed", "expired"].includes(
          run.status
        )
      ) {
        throw new Error("Wrong run status: " + run.status);
      }
    } catch (err) {
      console.log(err);
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.FAILED,
        failMessage: String(err),
      });
    }
  }

  @Interval(10000)
  async findReadyForShoppingMealGroup() {
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.MEAL_GENERATING },
      relations: ["meals"],
    });
    if (!mealGroup?.id) {
      return;
    }
    const mealsStatusList = Array(
      ...new Set(mealGroup.meals.map((el) => el.status))
    );
    if (
      mealsStatusList?.length === 1 &&
      mealsStatusList[0] === MealStatusEnum.GENERATED
    ) {
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.READY_FOR_SHOPPING,
      });
      return;
    }
  }

  @Interval(10000)
  async createShoppingList() {
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.READY_FOR_SHOPPING },
    });
    if (!mealGroup?.id) return;
    await this.mealGroupService.update(mealGroup.id, {
      status: MealGroupStatusEnum.SHOPPING_LIST_IN_PROGRESS,
    });
    await this.openAiService.addThreadMessage(mealGroup.threadId, {
      role: "user",
      content: "Write shopping list of ingredients for that thread",
    });
    const run = await this.openAiService.runAssistant(
      mealGroup.threadId,
      OpenAIAssistantEnum.NUTRI
    );
    if (!run?.id) return;
    await this.mealGroupService.update(mealGroup.id, {
      shoppingListRunId: run.id,
      status: MealGroupStatusEnum.AWAITING_SHOPPING_LIST,
    });
  }

  @Interval(40000)
  async checkShoppingListRun() {
    const mealGroup = await this.mealGroupService.findOne({
      where: { status: MealGroupStatusEnum.AWAITING_SHOPPING_LIST },
      relations: ["subscription", "subscription.user"],
    });
    if (!mealGroup?.id) return;

    try {
      const run = await this.openAiService.checkRun(
        mealGroup.threadId,
        mealGroup.shoppingListRunId
      );

      if (run.status === "completed") {
        const messages = await this.openAiService.getThreadMessages(
          mealGroup.threadId
        );

        const message = messages.data[0];
        if (!message?.id) {
          throw new Error(
            "Shopping List run: Message from Assistant is not provided"
          );
        }
        if (message.content[0].type !== "text") {
          throw new Error("Got not text response");
        }
        const response = message.content[0]?.text?.value;
        console.log("🚀 ~ MealGenerateCron ~ checkRuns ~ messages:", response);
        await this.mealGroupService.update(mealGroup.id, {
          shoppingList: response,
          status: MealGroupStatusEnum.READY_TO_SEND,
        });
        await this.bot.api.sendMessage(
          mealGroup.subscription.user.telegramId,
          response
        );
      } else if (
        ["requires_action", "cancelled", "failed", "expired"].includes(
          run.status
        )
      ) {
        throw new Error("Wrong run status: " + run.status);
      }
    } catch (err) {
      console.log(err);
      await this.mealGroupService.update(mealGroup.id, {
        status: MealGroupStatusEnum.FAILED,
        failMessage: String(err),
      });
    }
  }

  @Interval(20000)
  async checkSentMealGroups() {
    const mealGroups = await this.mealGroupService.find({
      where: { status: MealGroupStatusEnum.READY_TO_SEND },
      relations: ["meals"],
    });
    for (let mgIndex = 0; mgIndex < mealGroups.length; mgIndex++) {
      const mealsStatus = Array(
        ...new Set(mealGroups[mgIndex].meals.map((el) => el.status))
      );
      if (mealsStatus.length === 1 && mealsStatus[0] === MealStatusEnum.SENT) {
        // all meals was sent
        await this.mealGroupService.update(mealGroups[mgIndex].id, {
          status: MealGroupStatusEnum.COMPLETE,
        });
      }
    }
  }

  // @Interval(20000)
  async sendMeal() {
    const meal = await this.mealService.findOne({
      where: { status: MealStatusEnum.GENERATED },
      relations: ["user"],
    });
    if (!meal?.id) return;

    try {
      const content = markdownToNodes(meal.response);
      const title = `${getMealTypeLabels()[meal.type]} ${formatDateToShortDate(
        meal.date
      )}`;
      const pageResult = await this.telegraphService.createPage({
        title,
        content,
      });
      if (!pageResult.ok) throw new Error("Page not created");
      await this.bot.api.sendMessage(
        meal.user.telegramId,
        pageResult.result.url
      );
      await this.mealService.update(meal.id, {
        status: MealStatusEnum.SENT,
        url: pageResult.result.url,
      });
    } catch (err) {
      console.log(err);
      await this.mealService.update(meal.id, {
        status: MealStatusEnum.SENT_FAILED,
      });
    }
  }
}
