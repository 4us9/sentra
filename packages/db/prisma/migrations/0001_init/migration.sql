-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mandate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "user" TEXT NOT NULL,
    "policy" TEXT,
    "description" TEXT NOT NULL,
    "scope" TEXT[],
    "processor" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "budgetTotal" DOUBLE PRECISION NOT NULL,
    "perTxCap" DOUBLE PRECISION NOT NULL,
    "allowedRecipients" TEXT[],
    "velocityCount" INTEGER NOT NULL,
    "velocityWindowSec" INTEGER NOT NULL,
    "breakerBlocks" INTEGER NOT NULL,
    "breakerWindowSec" INTEGER NOT NULL,
    "outOfScope" TEXT NOT NULL DEFAULT 'review',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "seal" TEXT NOT NULL,
    "spent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "frozenReason" TEXT,
    "breakerResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "doc" TEXT NOT NULL,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "mandateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "processor" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "intentSource" TEXT NOT NULL,
    "decidedBy" JSONB,
    "payment" JSONB,
    "paymentId" TEXT,
    "resolves" TEXT,
    "effects" TEXT[],
    "latencyMs" DOUBLE PRECISION,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "doc" TEXT NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "keyHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_tokenHash_key" ON "Mandate"("tokenHash");

-- CreateIndex
CREATE INDEX "Mandate_tenantId_idx" ON "Mandate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_seq_key" ON "Decision"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_hash_key" ON "Decision"("hash");

-- CreateIndex
CREATE INDEX "Decision_mandateId_idx" ON "Decision"("mandateId");

-- CreateIndex
CREATE INDEX "Decision_verdict_idx" ON "Decision"("verdict");

-- CreateIndex
CREATE INDEX "Decision_createdAt_idx" ON "Decision"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "Mandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

