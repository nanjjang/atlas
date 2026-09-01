import mongoose, { Schema, model } from 'mongoose';

const locationSchema = new Schema({
  city: { type: String, required: true },
  country: String,
});

const activitySchema = new Schema({
  kind: { type: String, required: true },
  location: locationSchema,
  actor: { type: Schema.Types.ObjectId, ref: 'Session' },
  recordedAt: { type: Date, default: Date.now },
}, { collection: 'activity_log' });

const sessionSchema = new Schema({
  token: { type: String, required: true, unique: true },
  activity: [activitySchema],
});

export const Activity = model('Activity', activitySchema);
export const Session = mongoose.model('Session', sessionSchema);
