-- "Price before" per plan: shown struck through next to the price (a discount look). NULL = none.
ALTER TABLE plans ADD COLUMN price_before REAL;
