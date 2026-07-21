import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A normal, application-owned TypeORM entity. RagModule never generates or
 * requires entities like this one to exist — it just reads from it via an
 * entity source mapping (see app.module.ts).
 */
@Entity('knowledge_articles')
export class KnowledgeArticle {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  title!: string;

  @Column('text')
  content!: string;

  @Column({ default: 'general' })
  category!: string;

  @Column({ default: 'en' })
  language!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
