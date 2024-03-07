import { BadRequestException, Injectable } from "@nestjs/common";
import { TelegramFlowEnum } from "../enums/telegram-flow.enum";
import { TelegramStartFlowService } from "./telegram-start-flow.service";
import { TelegramFlowStepInterface } from "../interfaces/telegram-flow-step.interface";
import { TelegramRecipeFlowService } from "./telegram-recipe-flow.service";

@Injectable()
export class TelegramFlowService {
  constructor(
    private telegramStartFlowService: TelegramStartFlowService,
    private telegramRecipeFlowService: TelegramRecipeFlowService
  ) {}

  getFlowSteps(flow: TelegramFlowEnum): TelegramFlowStepInterface[] {
    const flows = {
      [TelegramFlowEnum.START]: this.telegramStartFlowService.getSteps(),
      [TelegramFlowEnum.RECIPE]: this.telegramRecipeFlowService.getSteps(),
    };
    const steps = flows[flow];
    if (!steps)
      throw new BadRequestException({ message: "Шаги для флоу не найдены" });
    return steps;
  }
}
