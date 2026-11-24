-- A teacher deleting an assignment removes its related records in the same transaction.
-- Upload blobs are content-addressed and may still be shared by other file records.
ALTER TABLE conversations DROP CONSTRAINT conversations_homework_id_fkey,
    ADD FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE CASCADE;
ALTER TABLE turns DROP CONSTRAINT turns_homework_id_fkey,
    ADD FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE CASCADE;
ALTER TABLE turns DROP CONSTRAINT turns_conversation_id_fkey,
    ADD FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE;
ALTER TABLE submissions DROP CONSTRAINT submissions_homework_id_fkey,
    ADD FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE CASCADE;
ALTER TABLE evaluations DROP CONSTRAINT evaluations_homework_id_fkey,
    ADD FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE CASCADE;
ALTER TABLE files DROP CONSTRAINT files_homework_id_fkey,
    ADD FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE CASCADE;
