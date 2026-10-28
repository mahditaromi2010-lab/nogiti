-- Rollback for 0005_support_tickets: drops both new tables (messages first via FK, then tickets).
DROP TABLE IF EXISTS ticket_messages;
DROP TABLE IF EXISTS tickets;
