import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { ApiExceptionFilter, AppModule } from "./app.js";

async function bootstrap() {
  loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
  if (!process.env.DATABASE_URL) loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log("Outbound HTTP proxy enabled");
  }
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: true, trustProxy: process.env.TRUST_PROXY === "true" }), { rawBody: true });
  app.setGlobalPrefix("api/v1");
  const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
  app.useGlobalFilters(new ApiExceptionFilter());
  const config = new DocumentBuilder().setTitle("BotCRM API").setDescription("Omnichannel control plane for custom bots").setVersion("1.0").addApiKey({ type: "apiKey", name: "x-service-token", in: "header" }, "service-token").build();
  const document = SwaggerModule.createDocument(app, config);
  const swaggerPath = (process.env.SWAGGER_PATH ?? "docs").replace(/^\/+|\/+$/g, "") || "docs";
  SwaggerModule.setup(swaggerPath, app, document, { jsonDocumentUrl: swaggerPath + "/openapi.json" });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4100);
  await app.listen(port, "0.0.0.0");
  console.log(`BotCRM API: http://localhost:${port}/api/v1/health`);
  console.log("OpenAPI: http://localhost:" + port + "/" + swaggerPath);
}
bootstrap().catch((error) => { console.error(error); process.exit(1); });
