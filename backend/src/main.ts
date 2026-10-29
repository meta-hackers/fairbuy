import { NestFactory } from "@nestjs/core";
import { AppModule, configureApp } from "./app.module.js";

const app = await NestFactory.create(AppModule);
configureApp(app);
await app.listen(Number(process.env.PORT ?? 3000));
