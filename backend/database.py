"""
Database configuration and models for FindPhotos.
Compatible with SQLite (default, viewable in DBeaver) or MySQL / PostgreSQL.
"""

import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import bcrypt
from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    create_engine,
    text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

# Database URL: defaults to local SQLite file 'findphotos.db' in backend/
DEFAULT_DB_PATH = Path(__file__).resolve().parent / "findphotos.db"
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH.as_posix()}")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ── Models ────────────────────────────────────────────────────────────────────

class Photographer(Base):
    __tablename__ = "photographers"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(150), nullable=False)
    email = Column(String(150), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    events = relationship("Event", back_populates="photographer", cascade="all, delete-orphan")

    def verify_password(self, password: str) -> bool:
        return bcrypt.checkpw(password.encode("utf-8"), self.password_hash.encode("utf-8"))


class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    event_id = Column(String(100), unique=True, index=True, nullable=False)
    photographer_id = Column(Integer, ForeignKey("photographers.id"), nullable=False)
    name = Column(String(200), nullable=False)
    event_password = Column(String(255), nullable=True, default="")
    drive_folder_id = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    photographer = relationship("Photographer", back_populates="events")


def init_db():
    """Create all tables in the database and ensure columns exist."""
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE events ADD COLUMN event_password VARCHAR(255) DEFAULT ''"))
            conn.commit()
        except Exception:
            pass  # column already exists


# ── Helper CRUD functions ─────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(rounds=10)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def register_photographer(name: str, email: str, password: str) -> Photographer:
    db = SessionLocal()
    try:
        existing = db.query(Photographer).filter(Photographer.email == email.strip().lower()).first()
        if existing:
            raise ValueError("An account with this email is already registered")

        user = Photographer(
            name=name.strip(),
            email=email.strip().lower(),
            password_hash=hash_password(password),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        db.close()


def authenticate_photographer(email: str, password: str) -> Optional[Photographer]:
    db = SessionLocal()
    try:
        user = db.query(Photographer).filter(Photographer.email == email.strip().lower()).first()
        if user and user.verify_password(password):
            return user
        return None
    finally:
        db.close()


def generate_event_id(name: str) -> str:
    """Generate a clean, unique event ID slug."""
    clean_slug = re.sub(r'[^a-zA-Z0-9]+', '_', name.lower()).strip('_')[:20]
    if not clean_slug:
        clean_slug = "event"
    return f"{clean_slug}_{uuid.uuid4().hex[:6]}"


def create_event_record(
    photographer_id: int,
    name: str,
    event_password: str = "",
    drive_folder_id: str = "",
    event_id: str = ""
) -> Event:
    db = SessionLocal()
    try:
        if not event_id:
            event_id = generate_event_id(name)

        existing = db.query(Event).filter(Event.event_id == event_id.strip()).first()
        if existing:
            existing.name = name.strip() or existing.name
            if drive_folder_id:
                existing.drive_folder_id = drive_folder_id.strip()
            if event_password:
                existing.event_password = event_password.strip()
            db.commit()
            db.refresh(existing)
            return existing

        evt = Event(
            event_id=event_id.strip(),
            photographer_id=photographer_id,
            name=name.strip() or event_id.strip(),
            event_password=event_password.strip(),
            drive_folder_id=drive_folder_id.strip(),
        )
        db.add(evt)
        db.commit()
        db.refresh(evt)
        return evt
    finally:
        db.close()


def get_photographer_events(photographer_id: int) -> list[Event]:
    db = SessionLocal()
    try:
        return db.query(Event).filter(Event.photographer_id == photographer_id).order_by(Event.created_at.desc()).all()
    finally:
        db.close()


def verify_event_access(event_identifier: str, event_password: str) -> Optional[Event]:
    """Verify attendee access using event name/id and event password."""
    db = SessionLocal()
    try:
        ident = event_identifier.strip()
        pwd = event_password.strip()

        # Search by exact event_id or case-insensitive name
        evt = db.query(Event).filter(
            (Event.event_id == ident) | (Event.name.ilike(ident))
        ).first()

        if not evt:
            return None

        # If event has a password set, verify it matches
        if evt.event_password and evt.event_password.strip():
            if evt.event_password.strip() != pwd:
                return None

        return evt
    finally:
        db.close()
