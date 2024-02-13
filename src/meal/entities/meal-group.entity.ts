import { AbstractEntity } from "src/shared/entities/abstract.entity";
import { Entity } from "typeorm";

@Entity("meal_groups")
export class MealGroupEntity extends AbstractEntity {
  meals;
}
