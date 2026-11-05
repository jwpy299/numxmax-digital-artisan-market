#!/usr/bin/env python3
"""Real PEFT LoRA fine-tuning with separated task input and masked target output."""
import argparse
import json

MAX_LEN = 1024


def build_training_example(row: dict, tokenizer) -> dict[str, list[int]]:
    prompt = f"你是部门数字员工，请按任务要求生成合格产出。\n任务：{row['input'].strip()}\n合格产出："
    prompt_ids = tokenizer(prompt, add_special_tokens=True, truncation=True, max_length=768)["input_ids"]
    remaining = MAX_LEN - len(prompt_ids)
    if remaining <= 1:
        raise ValueError("prompt_too_long")
    target_ids = tokenizer(row["response"].strip(), add_special_tokens=False, truncation=True, max_length=remaining - 1)["input_ids"]
    if getattr(tokenizer, "eos_token_id", None) is not None:
        target_ids.append(int(tokenizer.eos_token_id))
    if not target_ids:
        raise ValueError("empty_response")
    input_ids = prompt_ids + target_ids
    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": [-100] * len(prompt_ids) + target_ids,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=int, default=2)
    args = parser.parse_args()

    import torch
    from datasets import Dataset
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, DataCollatorForSeq2Seq, Trainer, TrainingArguments

    rows = [json.loads(line) for line in open(args.data, encoding="utf-8") if line.strip()]
    if len(rows) < 8:
        raise SystemExit("训练样本不足——拒绝空训练")
    if any(not str(row.get("input", "")).strip() or not str(row.get("response", "")).strip() for row in rows):
        raise SystemExit("样本缺真实输入或目标——拒绝输入目标混写")
    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32)
    model.config.use_cache = False
    config = LoraConfig(
        r=4,
        lora_alpha=8,
        lora_dropout=0.05,
        target_modules=["q_proj", "v_proj"],
        task_type=TaskType.CAUSAL_LM,
        bias="none",
    )
    model = get_peft_model(model, config)
    model.print_trainable_parameters()
    ds = Dataset.from_list([build_training_example(row, tokenizer) for row in rows])
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, model=model, padding=True)
    training = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        logging_steps=1,
        save_strategy="epoch",
        report_to=[],
        bf16=torch.cuda.is_available(),
        fp16=False,
        optim="adamw_torch",
        seed=42,
    )
    trainer = Trainer(model=model, args=training, train_dataset=ds, data_collator=collator)
    trainer.train()
    model.config.use_cache = True
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print(f"LORA_SAVED={args.out} SAMPLES={len(rows)} EPOCHS={args.epochs}")


if __name__ == "__main__":
    main()
