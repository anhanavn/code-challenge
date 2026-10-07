import 'dotenv/config';
import { loadConfig } from '../config.js';
import { createPostgresDatabase } from '../db/client.js';
import { TaskRepository } from '../modules/tasks/task.repository.js';
import type { CreateTaskInput } from '../modules/tasks/task.schema.js';
import { TaskService } from '../modules/tasks/task.service.js';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const samples: CreateTaskInput[] = [
  { title: 'Write API documentation', description: 'OpenAPI spec and README', status: 'done', priority: 'medium', dueDate: inDays(-2) },
  { title: 'Set up CI pipeline', description: 'Typecheck and tests on every push', status: 'done', priority: 'high', dueDate: inDays(-1) },
  { title: 'Add rate limiting', description: null, status: 'in_progress', priority: 'high', dueDate: inDays(1) },
  { title: 'Review pull requests', description: 'Two PRs waiting on the payments service', status: 'todo', priority: 'medium', dueDate: inDays(2) },
  { title: 'Plan Q4 roadmap', description: 'Draft with product team', status: 'todo', priority: 'low', dueDate: inDays(14) },
  { title: 'Fix flaky login test', description: 'Fails about 1 in 20 runs on CI', status: 'todo', priority: 'high', dueDate: null },
];

const database = createPostgresDatabase(loadConfig().DATABASE_URL, 1);
const service = new TaskService(new TaskRepository(database.db));
try {
  for (const input of samples) await service.create(input);
  console.log(`Seeded ${samples.length} tasks`);
} finally {
  await database.close();
}
