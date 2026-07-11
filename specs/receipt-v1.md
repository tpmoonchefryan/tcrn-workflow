# Receipt V1

Receipts conform to `receipt-v1.schema.json`. A receipt binds its stable ID,
exchange ID, strict receive instant, accepted/rejected status, and exact subject
digest. Receipts are immutable observations; replay uses a new stable receipt ID
and never overwrites an earlier receipt.

An accepted receipt proves only local schema/integrity admission, not release
trust, publication, or live service compatibility.
