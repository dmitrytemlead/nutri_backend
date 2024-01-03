import { AbstractEntity } from "src/shared/entities/abstract.entity";
import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from "typeorm";
import { QuestionGroupEntity } from "./question-group.entity";
import { QuestionTypeEnum } from "../enums/question-type.enum";
import { QuestionGradeEntity } from "./question-grade.entity";
import { UserQuestionnaireAnswerEntity } from "src/user/entities/user-questionnaire-answer.entity";
import { ApiPropertyString } from "src/shared/decorators/api.decorator";

@Entity("questions")
export class QuestionEntity extends AbstractEntity {
  @ApiPropertyString()
  @Column({ type: "text" })
  caption: string;

  @Column({ type: "text", nullable: true })
  description?: string;

  @Column({
    type: "enum",
    enum: QuestionTypeEnum,
    default: QuestionTypeEnum.FREETEXT,
  })
  type: QuestionTypeEnum;

  @Column({ type: "uuid" })
  groupId: string;

  @ManyToOne(() => QuestionGroupEntity, (entity) => entity.questions)
  @JoinColumn({ name: "groupId", referencedColumnName: "id" })
  group: QuestionGroupEntity;

  @OneToMany(() => QuestionGradeEntity, (entity) => entity.question, {
    cascade: true,
    onDelete: "CASCADE",
  })
  grades: QuestionGradeEntity[];

  @OneToMany(() => UserQuestionnaireAnswerEntity, (entity) => entity.question, {
    cascade: true,
    onDelete: "CASCADE",
  })
  answers: UserQuestionnaireAnswerEntity[];
}
