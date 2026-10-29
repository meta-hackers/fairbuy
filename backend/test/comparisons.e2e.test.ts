import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule, configureApp } from "../src/app.module.js";

// The demo request (PROPOSAL §4): at least 16 GB RAM, max €700 delivered, charger preferred.
const demoRequest = {
  category: "laptop",
  constraints: [
    { attribute: "ramGb", op: ">=", value: 16, hard: true },
    { attribute: "total", op: "<=", value: 70000, hard: true },
    { attribute: "chargerIncluded", op: "=", value: true, hard: false },
  ],
};

describe("comparisons API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app, {});
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the demo ranking: A first, B excluded, C unverified", async () => {
    const res = await request(app.getHttpServer()).post("/v1/comparisons").send(demoRequest).expect(201);

    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.connector).toBe("fixture");
    const { ranked, excluded, warnings } = res.body.result;
    expect(ranked.map((r: { offerId: string }) => r.offerId)).toEqual(["fixture-a", "fixture-c"]);
    expect(ranked[0].status).toBe("feasible");
    expect(ranked[1].status).toBe("unverified");
    expect(excluded.map((e: { offerId: string }) => e.offerId)).toEqual(["fixture-b"]);
    expect(warnings).toContain("Contains synthetic fixtures: not current offers.");
  });

  it("stores the comparison and returns it by id", async () => {
    const created = await request(app.getHttpServer()).post("/v1/comparisons").send(demoRequest).expect(201);
    const fetched = await request(app.getHttpServer()).get(`/v1/comparisons/${created.body.id}`).expect(200);
    expect(fetched.body).toEqual(created.body);
  });

  it("returns 404 for an unknown comparison", async () => {
    await request(app.getHttpServer()).get("/v1/comparisons/2f1c1f0e-8c0a-4b0e-9d3a-1c2b3d4e5f60").expect(404);
  });

  it("returns 400 for a malformed id", async () => {
    await request(app.getHttpServer()).get("/v1/comparisons/not-a-uuid").expect(400);
  });

  it("rejects an invalid constraint with the failing path", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/comparisons")
      .send({ category: "laptop", constraints: [{ attribute: "ramGb", op: "~", value: 16, hard: true }] })
      .expect(400);
    expect(res.body.issues[0].path).toBe("constraints.0.op");
  });

  it("rejects unknown fields", async () => {
    await request(app.getHttpServer())
      .post("/v1/comparisons")
      .send({ ...demoRequest, url: "http://localhost/admin" })
      .expect(400);
  });

  it("rejects weights that do not sum to 1", async () => {
    await request(app.getHttpServer())
      .post("/v1/comparisons")
      .send({ ...demoRequest, weights: { cost: 1, suitability: 1, reliability: 0 } })
      .expect(400);
  });

  it("rejects an unsupported category", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/comparisons")
      .send({ category: "washing_machine", constraints: [] })
      .expect(400);
    expect(res.body.message).toContain("Unsupported category");
  });

  it("applies custom weights", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/comparisons")
      .send({ category: "laptop", constraints: [], weights: { cost: 1, suitability: 0, reliability: 0 } })
      .expect(201);
    expect(res.body.result.ranked[0].offerId).toBe("fixture-b");
  });

  it("reports health", async () => {
    await request(app.getHttpServer()).get("/health").expect(200, { status: "ok" });
  });
});
